import { render } from "@testing-library/react";
import React from "react";
import App from "./App";

describe("App", () => {
  it('renders the version information with the "version" key', () => {
    process.env.REACT_APP_VERSION_FRONTEND = "v1";
    const { container } = render(<App />);
    const content = container.textContent;
    expect(content).toContain('"version"');
  });
});
