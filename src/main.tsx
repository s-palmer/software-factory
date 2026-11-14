import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import "./verify/verifiers";
import "./verify/specs";
import { installVerifyHandle } from "./verify/harness/handle";

installVerifyHandle();

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("#root not found");
createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
