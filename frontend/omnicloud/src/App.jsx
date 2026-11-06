import { useEffect, useState } from "react";
import LoginPage from "./loginPage/LoginPage";
import WorkspacePage from "./WorkspacePage";

export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [checkingSession, setCheckingSession] = useState(path === "/");

  useEffect(() => {
    const handleNavigation = () => setPath(window.location.pathname);
    window.addEventListener("popstate", handleNavigation);
    return () => window.removeEventListener("popstate", handleNavigation);
  }, []);

  useEffect(() => {
    if (path !== "/") {
      setCheckingSession(false);
      return;
    }
    let active = true;
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then((response) => {
        if (response.ok && active) {
          window.history.replaceState({}, "", "/workspace");
          setPath("/workspace");
        }
      })
      .catch(() => {})
      .finally(() => { if (active) setCheckingSession(false); });
    return () => { active = false; };
  }, [path]);

  if (checkingSession && path === "/") {
    return <main className="omni-workspace-page"><p className="omni-session-loading">Checking your session…</p></main>;
  }
  return path === "/workspace" ? <WorkspacePage /> : <LoginPage />;
}
