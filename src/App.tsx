import { EnvPage } from "./dashboard/pages/EnvPage";
import { HomePage } from "./dashboard/pages/HomePage";
import { ModelsPage } from "./dashboard/pages/ModelsPage";
import { RunPage } from "./dashboard/pages/RunPage";
import { RunsPage } from "./dashboard/pages/RunsPage";
import { TaskPage } from "./dashboard/pages/TaskPage";
import { Dashboard as VerifyDashboard } from "./verify/harness/Dashboard";
import { UnitPage } from "./verify/harness/UnitPage";

function route([section, id]: string[]) {
  if (section === "tasks" && id) return <TaskPage id={id} />;
  if (section === "models") return <ModelsPage />;
  if (section === "env") return <EnvPage />;
  if (section === "runs") return id ? <RunPage id={id} /> : <RunsPage />;
  return <HomePage />;
}

export function App() {
  const parts = window.location.pathname.split("/").filter(Boolean).map(decodeURIComponent);

  if (parts[0] === "verify") {
    const [, unitId, fixtureId] = parts;
    return unitId && fixtureId ? <UnitPage unitId={unitId} fixtureId={fixtureId} /> : <VerifyDashboard />;
  }

  return (
    <>
      <nav className="topbar">
        <a href="/" className="topbar__brand">Software Factory</a>
        <a href="/">Tasks</a>
        <a href="/env">Environment</a>
        <a href="/models">Models</a>
        <a href="/runs">Test runs</a>
        <a href="/verify">Verification</a>
      </nav>
      <main>{route(parts)}</main>
    </>
  );
}
