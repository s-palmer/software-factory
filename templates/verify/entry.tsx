/**
 * The verification harness page ({{entry}}). It runs inside your app's dev server but outside its router:
 * `{{entry}}` lists every unit and fixture; `{{entry}}?unit=<id>&fixture=<id>` mounts one, and `&chrome=0`
 * hides the report for a clean screenshot. `window.__verify` gives the same to Playwright and agents.
 */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import "./verifiers";
import "./specs";
import { setRouteFormat } from "./core/registry";
import { Dashboard } from "./harness/Dashboard";
import { installVerifyHandle } from "./harness/handle";
import { UnitPage } from "./harness/UnitPage";

setRouteFormat((unit, fixture) => `{{entry}}?unit=${encodeURIComponent(unit)}&fixture=${encodeURIComponent(fixture)}`);
installVerifyHandle();

const query = new URLSearchParams(window.location.search);
const unitId = query.get("unit");
const fixtureId = query.get("fixture");
const root = document.getElementById("verify-root");
if (!root) throw new Error("#verify-root not found");
createRoot(root).render(unitId && fixtureId ? createElement(UnitPage, { unitId, fixtureId }) : createElement(Dashboard));
