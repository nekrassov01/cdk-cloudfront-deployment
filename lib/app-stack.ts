import {
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as cloudfront_origins,
  aws_iam as iam,
  aws_route53 as route53,
  aws_route53_targets as route53_targets,
  aws_s3 as s3,
  aws_ssm as ssm,
} from "aws-cdk-lib";
import { Construct } from "constructs";

export interface CloudFrontDeploymentSampleAppStackProps extends StackProps {
  serviceName: string;
  hostedZoneName: string;
  webAclArn: string;
}

export class CloudFrontDeploymentSampleAppStack extends Stack {
  constructor(scope: Construct, id: string, props: CloudFrontDeploymentSampleAppStackProps) {
    super(scope, id, props);

    const { serviceName, hostedZoneName, webAclArn } = props;
    const domainName = `${serviceName}.${hostedZoneName}`;

    // Get version of application frontend from SSM parameter store
    const frontendVersion = ssm.StringParameter.valueForTypedStringParameterV2(
      this,
      `/${serviceName}/version/frontend`,
      ssm.ParameterValueType.STRING
    );

    // Get hosted zone domain name
    const hostedZone = route53.HostedZone.fromLookup(this, "HostedZone", {
      domainName: hostedZoneName,
    });

    // Create certificate for CloudFront
    const certificate = new acm.DnsValidatedCertificate(this, "Certificate", {
      certificateName: `${serviceName}-certificate`,
      domainName: domainName,
      subjectAlternativeNames: [`*.${domainName}`],
      region: "us-east-1",
      validation: acm.CertificateValidation.fromDns(),
      cleanupRoute53Records: false, // for safety
      hostedZone: hostedZone,
    });

    /**
     * Hosting bucket
     */

    // Create hosting bucket
    const hostingBucket = new s3.Bucket(this, "HostingBucket", {
      bucketName: `${serviceName}-website`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: false,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
      //websiteIndexDocument: "index.html", // error if this is present
      //websiteErrorDocument: "index.html", // same as above
      cors: [
        {
          allowedHeaders: ["*"],
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: [`https://${domainName}`, `https://*.${domainName}`],
          exposedHeaders: [],
          maxAge: 3000,
        },
      ],
    });

    /**
     * CloudFront
     */

    // Create CloudFront accesslog bucket
    const cloudfrontLogBucket = new s3.Bucket(this, "CloudFrontLogBucket", {
      bucketName: `${serviceName}-cloudfront-log`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      versioned: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED, // required in cloudfront accesslog bucket
    });

    // Create OriginAccessControl
    const hostingOac = new cloudfront.CfnOriginAccessControl(this, "HostingOac", {
      originAccessControlConfig: {
        name: hostingBucket.bucketDomainName,
        originAccessControlOriginType: "s3",
        signingBehavior: "always",
        signingProtocol: "sigv4",
        description: hostingBucket.bucketDomainName,
      },
    });

    // Create CloudFront distribution
    // NOTE: CloudFront continuous deployment does not support HTTP3
    const distributionName = `${serviceName}-distribution`;
    const indexPage = "index.html";
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      enabled: true,
      comment: distributionName,
      domainNames: [domainName],
      defaultRootObject: indexPage,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      httpVersion: cloudfront.HttpVersion.HTTP2,
      certificate: certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      enableIpv6: false,
      enableLogging: true,
      logBucket: cloudfrontLogBucket,
      logFilePrefix: distributionName,
      logIncludesCookies: true,
      webAclId: webAclArn,
      defaultBehavior: {
        origin: new cloudfront_origins.S3Origin(hostingBucket, {
          originPath: `/${frontendVersion}`,
          connectionAttempts: 3,
          connectionTimeout: Duration.seconds(10),
        }),
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        //cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // cache disabling for test
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        responseHeadersPolicy:
          cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS_WITH_PREFLIGHT_AND_SECURITY_HEADERS,
        smoothStreaming: false,
      },
      errorResponses: [
        {
          ttl: Duration.seconds(0),
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: `/${indexPage}`,
        },
        {
          ttl: Duration.seconds(0),
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: `/${indexPage}`,
        },
      ],
    });

    // Override L1 properties
    const cfnDistribution = distribution.node.defaultChild as cloudfront.CfnDistribution;
    cfnDistribution.addPropertyOverride("DistributionConfig.Origins.0.Id", "hosting-bucket");
    cfnDistribution.addPropertyOverride("DistributionConfig.DefaultCacheBehavior.TargetOriginId", "hosting-bucket");
    cfnDistribution.addPropertyOverride("DistributionConfig.Origins.0.S3OriginConfig.OriginAccessIdentity", "");
    cfnDistribution.addPropertyOverride("DistributionConfig.Origins.0.OriginAccessControlId", hostingOac.attrId);

    // Create policy for hosting bucket
    const hostingBucketPolicyStatement = new iam.PolicyStatement({
      principals: [new iam.ServicePrincipal("cloudfront.amazonaws.com")],
      effect: iam.Effect.ALLOW,
      resources: [`${hostingBucket.bucketArn}/*`],
      actions: ["s3:GetObject"],
    });
    hostingBucketPolicyStatement.addCondition("StringEquals", {
      "AWS:SourceAccount": this.account,
    });

    // Add bucket policy to hosting bucket
    hostingBucket.addToResourcePolicy(hostingBucketPolicyStatement);

    // Alias record for CloudFront
    const distributionARecord = new route53.ARecord(this, "DistributionARecord", {
      recordName: domainName,
      target: route53.RecordTarget.fromAlias(new route53_targets.CloudFrontTarget(distribution)),
      zone: hostedZone,
    });
    distributionARecord.node.addDependency(distribution);

    /**
     * Put parameters
     */

    // Put distributionId to SSM parameter store
    new ssm.StringParameter(this, "CloudFrontProductionDistributionParameter", {
      parameterName: `/${serviceName}/cloudfront/cfcd-production`,
      stringValue: distribution.distributionId,
    });
    new ssm.StringParameter(this, "CloudFrontStagingDistributionParameter", {
      parameterName: `/${serviceName}/cloudfront/cfcd-staging`,
      stringValue: "dummy",
    });

    // Put bucketName to SSM parameter store
    new ssm.StringParameter(this, "HostingBucketParameter", {
      parameterName: `/${serviceName}/s3/website`,
      stringValue: hostingBucket.bucketName,
    });
    new ssm.StringParameter(this, "CloudFrontLogBucketParameter", {
      parameterName: `/${serviceName}/s3/cloudfront-log`,
      stringValue: cloudfrontLogBucket.bucketName,
    });
  }
}
