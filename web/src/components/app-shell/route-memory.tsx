import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "@/hooks/use-sessions";
import {
  clearLastRoute,
  defaultNewSessionHref,
  readLastRoute,
  rememberLastRoute,
  sessionIdFromRoute,
  shouldValidateRestoredSession,
} from "@/lib/route-memory";
import { readWorkspacePath } from "@/lib/workspaces";

export function RouteMemory() {
  const navigate = useNavigate();
  const location = useLocation();
  const [bootRoute] = useState(() => readLastRoute());
  const [restoreSettled, setRestoreSettled] = useState(false);
  const restoredRef = useRef(false);

  const pendingSessionId = shouldValidateRestoredSession(bootRoute, location.pathname);
  const sessionQuery = useSession(pendingSessionId ?? undefined);

  useEffect(() => {
    if (!bootRoute || restoredRef.current) {
      setRestoreSettled(true);
      return;
    }
    if (location.pathname !== "/") {
      restoredRef.current = true;
      setRestoreSettled(true);
      return;
    }
    if (sessionIdFromRoute(bootRoute)) return;
    restoredRef.current = true;
    setRestoreSettled(true);
    navigate(bootRoute, { replace: true });
  }, [bootRoute, location.pathname, navigate]);

  useEffect(() => {
    if (!pendingSessionId || restoredRef.current) return;
    if (sessionQuery.data) {
      restoredRef.current = true;
      setRestoreSettled(true);
      navigate(`/tasks/${encodeURIComponent(pendingSessionId)}`, { replace: true });
      return;
    }
    if (sessionQuery.isError) {
      restoredRef.current = true;
      setRestoreSettled(true);
      clearLastRoute();
    }
  }, [navigate, pendingSessionId, sessionQuery.data, sessionQuery.isError]);

  useEffect(() => {
    if (!restoreSettled) return;
    const href = defaultNewSessionHref(location.pathname, location.search, readWorkspacePath());
    if (!href) return;
    navigate(href, { replace: true });
  }, [location.pathname, location.search, navigate, restoreSettled]);

  useEffect(() => {
    if (location.pathname === "/") return;
    rememberLastRoute(location.pathname);
  }, [location.pathname]);

  return null;
}
