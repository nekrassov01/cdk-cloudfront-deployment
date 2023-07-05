import {
  RemovalPolicy,
  Stack,
  StackProps,
  aws_codebuild as codebuild,
  aws_codecommit as codecommit,
  aws_codepipeline as codepipeline,
  aws_codepipeline_actions as codepipeline_actions,
  aws_events as events,
  aws_events_targets as events_targets,
  aws_iam as iam,
  aws_logs as logs,
  aws_s3 as s3,
  aws_sns as sns,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export interface CloudFrontDeploymentSampleCicdStackProps extends StackProps {
  serviceName: string;
  repositoryName: string;
  branch: string;
  addresses: string[];
  webAclArn: string;
  buildspecDir: string;
  cloudfrontConfig: {
    singleHeaderConfig: {
      header: string;
      value: boolean;
    };
    stagingDistributionCleanupEnabled: boolean;
  };
}

export class CloudFrontDeploymentSampleCicdStack extends Stack {
  constructor(scope: Construct, id: string, props: CloudFrontDeploymentSampleCicdStackProps) {
    super(scope, id, props);

    const { serviceName, repositoryName, branch, addresses, webAclArn, buildspecDir, cloudfrontConfig } = props;
    const sourceStageName = "Source";
    const buildStageName = "Build";
    const deployStageName = "Deploy";
    const approveStageName = "Approve";
    const promoteStageName = "Promote";
    const cleanupStageName = "Cleanup";

    /**
     * Get parameters
     */

    // Get hosting bucket
    const hostingBucketName = ssm.StringParameter.valueForTypedStringParameterV2(
      this,
      `/${serviceName}/s3/website`,
      ssm.ParameterValueType.STRING
    );
    const hostingBucket = s3.Bucket.fromBucketName(this, "HostingBucket", hostingBucketName);

    // Get cloudfront log bucket
    const cloudfrontLogBucketName = ssm.StringParameter.valueForTypedStringParameterV2(
      this,
      `/${serviceName}/s3/cloudfront-log`,
      ssm.ParameterValueType.STRING
    );
    const cloudfrontLogBucket = s3.Bucket.fromBucketName(this, "CloudFrontLogBucket", cloudfrontLogBucketName);

    // Get cloudfront distribution id
    const distributionId = ssm.StringParameter.valueForTypedStringParameterV2(
      this,
      `/${serviceName}/cloudfront/cfcd-production`,
      ssm.ParameterValueType.STRING
    );

    // Get codecommit repositoryName
    const codeCommitRepository = codecommit.Repository.fromRepositoryName(this, "CodeCommitRepository", repositoryName);

    /**
     * Frontend pipeline
     */

    // Create frontend pipeline artifact output
    const frontendSourceOutput = new codepipeline.Artifact(sourceStageName);
    const frontendBuildOutput = new codepipeline.Artifact(buildStageName);
    const frontendDeployOutput = new codepipeline.Artifact(deployStageName);
    const frontendPromoteOutput = new codepipeline.Artifact(promoteStageName);

    // Create s3 bucket for frontend pipeline artifact
    const frontendArtifactBucket = new s3.Bucket(this, "FrontendArtifactBucket", {
      bucketName: `${serviceName}-pipeline-artifact-frontend`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
    });

    // Create codebuild project role for frontend build
    const frontendBuildProjectRole = new iam.Role(this, "FrontendBuildProjectRole", {
      roleName: `${serviceName}-frontend-build-project-role`,
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
    });

    // Create codebuild project for frontend build
    const frontendBuildProject = new codebuild.PipelineProject(this, "FrontendBuildProject", {
      projectName: `${serviceName}-frontend-build-project`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename(`${buildspecDir}/buildspec.frontend.build.yml`),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
      },
      environmentVariables: {
        REACT_APP_VERSION_FRONTEND: {
          type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
          value: `/${serviceName}/version/frontend`,
        },
      },
      badge: false,
      role: frontendBuildProjectRole,
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, "FrontendBuildProjectLogGroup", {
            logGroupName: `/${serviceName}/codebuild/frontend-build-project`,
            removalPolicy: RemovalPolicy.DESTROY,
            retention: logs.RetentionDays.THREE_DAYS,
          }),
        },
      },
    });

    // Create codebuild project role for frontend deploy
    const frontendDeployProjectRole = new iam.Role(this, "FrontendDeployProjectRole", {
      roleName: `${serviceName}-frontend-deploy-project-role`,
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      inlinePolicies: {
        ["FrontendDeployProjectRoleAdditionalPolicy"]: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter"],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["s3:ListBucket", "s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
              resources: [hostingBucket.bucketArn, hostingBucket.bucketArn + "/*"],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["s3:GetBucketAcl", "s3:PutBucketAcl"],
              resources: [cloudfrontLogBucket.bucketArn, cloudfrontLogBucket.bucketArn + "/*"],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "cloudfront:GetDistribution",
                "cloudfront:GetDistributionConfig",
                "cloudfront:CreateDistribution",
                "cloudfront:UpdateDistribution",
                "cloudfront:CopyDistribution",
                "cloudfront:GetInvalidation",
                "cloudfront:CreateInvalidation",
                "cloudfront:TagResource",
              ],
              resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "cloudfront:GetContinuousDeploymentPolicy",
                "cloudfront:CreateContinuousDeploymentPolicy",
                "cloudfront:UpdateContinuousDeploymentPolicy",
              ],
              resources: [`arn:aws:cloudfront::${this.account}:continuous-deployment-policy/*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["wafv2:GetWebACL"],
              resources: [webAclArn],
            }),
          ],
        }),
      },
    });

    // Create codebuild project for frontend deploy
    const frontendDeployProject = new codebuild.PipelineProject(this, "FrontendDeployProject", {
      projectName: `${serviceName}-frontend-deploy-project`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename(`${buildspecDir}/buildspec.frontend.deploy.yml`),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
      },
      environmentVariables: {
        SERVICE: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: serviceName,
        },
        BUCKET_NAME: {
          type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
          value: `/${serviceName}/s3/website`,
        },
        PRODUCTION_DISTRIBUTION_ID: {
          type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
          value: `/${serviceName}/cloudfront/cfcd-production`,
        },
        STAGING_DISTRIBUTION_ID: {
          type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
          value: `/${serviceName}/cloudfront/cfcd-staging`,
        },
        STAGING_DISTRIBUTION_CLEANUP_ENABLED: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: cloudfrontConfig.stagingDistributionCleanupEnabled,
        },
        CONTINUOUS_DEPLOYMENT_POLICY_CUSTOM_HEADER: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: JSON.stringify(cloudfrontConfig.singleHeaderConfig),
        },
        FRONTEND_VERSION: {
          type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
          value: `/${serviceName}/version/frontend`,
        },
      },
      badge: false,
      role: frontendDeployProjectRole,
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, "FrontendDeployProjectLogGroup", {
            logGroupName: `/${serviceName}/codebuild/frontend-deploy-project`,
            removalPolicy: RemovalPolicy.DESTROY,
            retention: logs.RetentionDays.THREE_DAYS,
          }),
        },
      },
    });

    // Create codebuild project role for frontend promote
    const frontendPromoteProjectRole = new iam.Role(this, "FrontendPromoteProjectRole", {
      roleName: `${serviceName}-frontend-promote-project-role`,
      assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
      inlinePolicies: {
        ["FrontendPromoteProjectRoleAdditionalPolicy"]: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter"],
              resources: [`arn:aws:ssm:${this.region}:${this.account}:*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["s3:GetBucketAcl", "s3:PutBucketAcl"],
              resources: [cloudfrontLogBucket.bucketArn, cloudfrontLogBucket.bucketArn + "/*"],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "cloudfront:GetDistribution",
                "cloudfront:GetDistributionConfig",
                "cloudfront:UpdateDistribution",
                "cloudfront:GetInvalidation",
                "cloudfront:CreateInvalidation",
              ],
              resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["cloudfront:GetContinuousDeploymentPolicy"],
              resources: [`arn:aws:cloudfront::${this.account}:continuous-deployment-policy/*`],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["wafv2:GetWebACL"],
              resources: [webAclArn],
            }),
          ],
        }),
      },
    });

    // Create codebuild project for frontend promote
    const frontendPromoteProject = new codebuild.PipelineProject(this, "FrontendPromoteProject", {
      projectName: `${serviceName}-frontend-promote-project`,
      buildSpec: codebuild.BuildSpec.fromSourceFilename(`${buildspecDir}/buildspec.frontend.promote.yml`),
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
      },
      environmentVariables: {
        PRODUCTION_DISTRIBUTION_ID: {
          type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
          value: `/${serviceName}/cloudfront/cfcd-production`,
        },
        STAGING_DISTRIBUTION_ID: {
          type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
          value: `/${serviceName}/cloudfront/cfcd-staging`,
        },
      },
      badge: false,
      role: frontendPromoteProjectRole,
      logging: {
        cloudWatch: {
          logGroup: new logs.LogGroup(this, "FrontendPromoteProjectLogGroup", {
            logGroupName: `/${serviceName}/codebuild/frontend-promote-project`,
            removalPolicy: RemovalPolicy.DESTROY,
            retention: logs.RetentionDays.THREE_DAYS,
          }),
        },
      },
    });

    // Create codecommit role for frontend
    const frontendSourceActionRole = new iam.Role(this, "FrontendSourceActionRole", {
      roleName: `${serviceName}-frontend-source-role`,
      assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`),
    });

    // Create event role for frontend
    const frontendSourceActionEventRole = new iam.Role(this, "FrontendSourceActionEventRole", {
      roleName: `${serviceName}-frontend-source-event-role`,
      assumedBy: new iam.ServicePrincipal("events.amazonaws.com"),
    });

    // Create codebuild build project role for frontend
    const frontendBuildActionRole = new iam.Role(this, "FrontendBuildActionRole", {
      roleName: `${serviceName}-frontend-build-action-role`,
      assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`),
    });

    // Create codebuild deploy project role for frontend
    const frontendDeployActionRole = new iam.Role(this, "FrontendDeployActionRole", {
      roleName: `${serviceName}-frontend-deploy-action-role`,
      assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`),
    });

    // Create codebuild approve project role for frontend
    const frontendApproveActionRole = new iam.Role(this, "FrontendApproveActionRole", {
      roleName: `${serviceName}-frontend-approve-action-role`,
      assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`),
    });

    // Create codebuild promote project role for frontend
    const frontendPromoteActionRole = new iam.Role(this, "FrontendPromoteActionRole", {
      roleName: `${serviceName}-frontend-promote-action-role`,
      assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`),
    });

    // Create frontend pipeline action for source stage
    const frontendSourceAction = new codepipeline_actions.CodeCommitSourceAction({
      actionName: sourceStageName,
      repository: codeCommitRepository,
      branch: branch,
      output: frontendSourceOutput,
      role: frontendSourceActionRole,
      runOrder: 1,
      trigger: codepipeline_actions.CodeCommitTrigger.NONE,
    });

    // Create frontend pipeline action for build stag
    const frontendBuildAction = new codepipeline_actions.CodeBuildAction({
      actionName: buildStageName,
      project: frontendBuildProject,
      input: frontendSourceOutput,
      outputs: [frontendBuildOutput],
      role: frontendBuildActionRole,
      runOrder: 1,
    });

    // Create frontend pipeline action for deploy stage
    const frontendDeployAction = new codepipeline_actions.CodeBuildAction({
      actionName: deployStageName,
      project: frontendDeployProject,
      input: frontendBuildOutput,
      outputs: [frontendDeployOutput],
      role: frontendDeployActionRole,
      runOrder: 1,
    });

    // Create frontend pipeline action for approval stage
    const frontendApproveAction = new codepipeline_actions.ManualApprovalAction({
      actionName: approveStageName,
      role: frontendApproveActionRole,
      externalEntityLink: `https://us-east-1.console.aws.amazon.com/cloudfront/v3/home#/distributions/${distributionId}`,
      additionalInformation: `Access the staging distribution with the "aws-cf-cd-staging: true" request header and test your application.
      Once approved, the production distribution configuration will be overridden with staging configuration.`,
      notificationTopic: new sns.Topic(this, "ApprovalStageTopic", {
        topicName: `${serviceName}-frontend-approval-topic`,
        displayName: `${serviceName}-frontend-approval-topic`,
      }),
      notifyEmails: addresses,
      runOrder: 1,
    });

    // Create frontend pipeline action for promote stage
    const frontendPromoteAction = new codepipeline_actions.CodeBuildAction({
      actionName: promoteStageName,
      project: frontendPromoteProject,
      input: frontendDeployOutput,
      outputs: [frontendPromoteOutput],
      role: frontendPromoteActionRole,
      runOrder: 1,
    });

    // Create frontend pipeline role
    const frontendPipelineRole = new iam.Role(this, "FrontendPipelineRole", {
      roleName: `${serviceName}-frontend-pipeline-role`,
      assumedBy: new iam.ServicePrincipal("codepipeline.amazonaws.com"),
      inlinePolicies: {
        ["FrontendPipelineRoleAdditionalPolicy"]: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["codebuild:BatchGetBuilds", "codebuild:StartBuild"],
              resources: [
                frontendBuildProject.projectArn,
                frontendDeployProject.projectArn,
                frontendPromoteProject.projectArn,
              ],
            }),
          ],
        }),
      },
    });

    // Create frontend pipeline
    const frontendPipeline = new codepipeline.Pipeline(this, "FrontendPipeline", {
      pipelineName: `${serviceName}-frontend-pipeline`,
      role: frontendPipelineRole,
      artifactBucket: frontendArtifactBucket,
    });
    frontendPipeline.addStage({
      stageName: sourceStageName,
      actions: [frontendSourceAction],
    });
    frontendPipeline.addStage({
      stageName: buildStageName,
      actions: [frontendBuildAction],
    });
    frontendPipeline.addStage({
      stageName: deployStageName,
      actions: [frontendDeployAction],
    });
    frontendPipeline.addStage({
      stageName: approveStageName,
      actions: [frontendApproveAction],
    });
    frontendPipeline.addStage({
      stageName: promoteStageName,
      actions: [frontendPromoteAction],
    });

    // Create eventbridge rule when source change
    const frontendSourceActionEventRule = new events.Rule(this, "FrontendSourceActionEventRule", {
      enabled: true,
      ruleName: `${serviceName}-frontend-source-rule`,
      eventPattern: {
        source: ["aws.codecommit"],
        detailType: ["CodeCommit Repository State Change"],
        resources: [codeCommitRepository.repositoryArn],
        detail: {
          event: ["referenceUpdated"],
          referenceName: [branch],
        },
      },
    });
    frontendSourceActionEventRule.addTarget(
      new events_targets.CodePipeline(frontendPipeline, {
        eventRole: frontendSourceActionEventRole,
      })
    );

    // Add policy to frontend artifact bucket
    frontendArtifactBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [
          new iam.ArnPrincipal(frontendSourceActionEventRole.roleArn),
          new iam.ArnPrincipal(frontendBuildProjectRole.roleArn),
          new iam.ArnPrincipal(frontendDeployProjectRole.roleArn),
          new iam.ArnPrincipal(frontendPromoteProjectRole.roleArn),
          new iam.ArnPrincipal(frontendPipelineRole.roleArn),
        ],
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [frontendArtifactBucket.bucketArn, frontendArtifactBucket.bucketArn + "/*"],
      })
    );

    /**
     * Cleanup process (if context.stagingDistributionCleanupEnabled is true)
     */

    if (cloudfrontConfig.stagingDistributionCleanupEnabled) {
      // Create codebuild project role for frontend cleanup
      const frontendCleanupProjectRole = new iam.Role(this, "FrontendCleanupProjectRole", {
        roleName: `${serviceName}-frontend-cleanup-project-role`,
        assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
        inlinePolicies: {
          ["FrontendCleanupProjectRoleAdditionalPolicy"]: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter"],
                resources: [`arn:aws:ssm:${this.region}:${this.account}:*`],
              }),
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["s3:GetBucketAcl", "s3:PutBucketAcl"],
                resources: [cloudfrontLogBucket.bucketArn, cloudfrontLogBucket.bucketArn + "/*"],
              }),
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                  "cloudfront:GetDistribution",
                  "cloudfront:GetDistributionConfig",
                  "cloudfront:DeleteDistribution",
                  "cloudfront:UpdateDistribution",
                  "cloudfront:GetInvalidation",
                  "cloudfront:CreateInvalidation",
                ],
                resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
              }),
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["cloudfront:GetContinuousDeploymentPolicy", "cloudfront:DeleteContinuousDeploymentPolicy"],
                resources: [`arn:aws:cloudfront::${this.account}:continuous-deployment-policy/*`],
              }),
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["wafv2:GetWebACL"],
                resources: [webAclArn],
              }),
            ],
          }),
        },
      });

      // Create codebuild project for frontend cleanup
      const frontendCleanupProject = new codebuild.PipelineProject(this, "FrontendCleanupProject", {
        projectName: `${serviceName}-frontend-cleanup-project`,
        buildSpec: codebuild.BuildSpec.fromSourceFilename(`${buildspecDir}/buildspec.frontend.cleanup.yml`),
        environment: {
          buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
        },
        environmentVariables: {
          SERVICE: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: serviceName,
          },
          PRODUCTION_DISTRIBUTION_ID: {
            type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
            value: `/${serviceName}/cloudfront/cfcd-production`,
          },
          STAGING_DISTRIBUTION_ID: {
            type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
            value: `/${serviceName}/cloudfront/cfcd-staging`,
          },
        },
        badge: false,
        role: frontendCleanupProjectRole,
        logging: {
          cloudWatch: {
            logGroup: new logs.LogGroup(this, "FrontendCleanupProjectLogGroup", {
              logGroupName: `/${serviceName}/codebuild/frontend-cleanup-project`,
              removalPolicy: RemovalPolicy.DESTROY,
              retention: logs.RetentionDays.THREE_DAYS,
            }),
          },
        },
      });

      // Add policy to frontend pipeline
      frontendPipelineRole.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["codebuild:BatchGetBuilds", "codebuild:StartBuild"],
          resources: [frontendCleanupProject.projectArn],
        })
      );

      // Create codebuild cleanup project role for frontend
      const frontendCleanupActionRole = new iam.Role(this, "FrontendCleanupActionRole", {
        roleName: `${serviceName}-frontend-cleanup-action-role`,
        assumedBy: new iam.ArnPrincipal(`arn:aws:iam::${this.account}:root`),
      });

      // Create cleanup action
      const frontendCleanupAction = new codepipeline_actions.CodeBuildAction({
        actionName: cleanupStageName,
        project: frontendCleanupProject,
        input: frontendPromoteOutput,
        outputs: undefined,
        role: frontendCleanupActionRole,
        runOrder: 1,
      });

      // Add stage to frontend pipeline
      frontendPipeline.addStage({
        stageName: cleanupStageName,
        actions: [frontendCleanupAction],
      });

      // Add policy to frontend artifact bucket
      frontendArtifactBucket.addToResourcePolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          principals: [new iam.ArnPrincipal(frontendCleanupProjectRole.roleArn)],
          actions: ["s3:GetObject", "s3:PutObject"],
          resources: [frontendArtifactBucket.bucketArn, frontendArtifactBucket.bucketArn + "/*"],
        })
      );

      // Create codebuild project role when approval failed
      const frontendPurgeProjectRole = new iam.Role(this, "FrontendPurgeProjectRole", {
        roleName: `${serviceName}-frontend-purge-project-role`,
        assumedBy: new iam.ServicePrincipal("codebuild.amazonaws.com"),
        inlinePolicies: {
          ["FrontendPurgeProjectRoleAdditionalPolicy"]: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["ssm:GetParameter", "ssm:GetParameters", "ssm:PutParameter"],
                resources: [`arn:aws:ssm:${this.region}:${this.account}:*`],
              }),
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["s3:GetBucketAcl", "s3:PutBucketAcl"],
                resources: [cloudfrontLogBucket.bucketArn, cloudfrontLogBucket.bucketArn + "/*"],
              }),
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                  "cloudfront:GetDistribution",
                  "cloudfront:GetDistributionConfig",
                  "cloudfront:DeleteDistribution",
                  "cloudfront:UpdateDistribution",
                  "cloudfront:GetInvalidation",
                  "cloudfront:CreateInvalidation",
                ],
                resources: [`arn:aws:cloudfront::${this.account}:distribution/*`],
              }),
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: [
                  "cloudfront:GetContinuousDeploymentPolicy",
                  "cloudfront:DeleteContinuousDeploymentPolicy",
                  "cloudfront:ListContinuousDeploymentPolicies",
                ],
                resources: [`arn:aws:cloudfront::${this.account}:continuous-deployment-policy/*`],
              }),
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                actions: ["wafv2:GetWebACL"],
                resources: [webAclArn],
              }),
            ],
          }),
        },
      });

      // Create codebuild project when approval failed
      const frontendPurgeProject = new codebuild.Project(this, "FrontendPurgeProject", {
        projectName: `${serviceName}-frontend-purge-project`,
        source: codebuild.Source.codeCommit({
          repository: codeCommitRepository,
          branchOrRef: branch,
          cloneDepth: 1,
        }),
        buildSpec: codebuild.BuildSpec.fromSourceFilename(`${buildspecDir}/buildspec.frontend.cleanup.yml`),
        environment: {
          buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_4,
        },
        environmentVariables: {
          SERVICE: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: serviceName,
          },
          PRODUCTION_DISTRIBUTION_ID: {
            type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
            value: `/${serviceName}/cloudfront/cfcd-production`,
          },
          STAGING_DISTRIBUTION_ID: {
            type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
            value: `/${serviceName}/cloudfront/cfcd-staging`,
          },
        },
        badge: false,
        role: frontendPurgeProjectRole,
        logging: {
          cloudWatch: {
            logGroup: new logs.LogGroup(this, "FrontendPurgeProjectLogGroup", {
              logGroupName: `/${serviceName}/codebuild/frontend-purge-project`,
              removalPolicy: RemovalPolicy.DESTROY,
              retention: logs.RetentionDays.THREE_DAYS,
            }),
          },
        },
      });
      // Create event role for frontend cleanup project when apploval failed
      const frontendPurgeEventRole = new iam.Role(this, "frontendPurgeEventRole", {
        roleName: `${serviceName}-frontend-purge-event-role`,
        assumedBy: new iam.ServicePrincipal("events.amazonaws.com"),
      });

      // Create eventbridge rule when approval failed
      const frontendPipelinPurgeEventRule = new events.Rule(this, "FrontendPurgeEventRule", {
        enabled: true,
        ruleName: `${serviceName}-frontend-purge-rule`,
        eventPattern: {
          source: ["aws.codepipeline"],
          detailType: ["CodePipeline Action Execution State Change"],
          resources: [frontendPipeline.pipelineArn],
          detail: {
            stage: [approveStageName],
            action: [approveStageName],
            state: ["FAILED"],
          },
        },
      });
      frontendPipelinPurgeEventRule.addTarget(
        new events_targets.CodeBuildProject(frontendPurgeProject, {
          eventRole: frontendPurgeEventRole,
        })
      );
    }
  }
}
