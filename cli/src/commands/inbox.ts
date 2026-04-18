import React from "react";
import { render } from "ink";
import { App } from "../inbox/App.js";

export const cmdInbox = () => {
  if (!process.stdout.isTTY) {
    console.error(
      "cos inbox requires an interactive TTY (run from a terminal, not a pipe).",
    );
    process.exit(2);
  }
  const { waitUntilExit } = render(React.createElement(App));
  waitUntilExit().catch((e) => {
    console.error(e);
    process.exit(1);
  });
};
