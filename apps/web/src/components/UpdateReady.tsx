/**
 * "There is a new version" - a bar, not a reload.
 *
 * A service worker set to update itself activates the moment it finishes
 * downloading, which can swap the code under a form somebody is halfway
 * through typing a balance into. Everything else in this app follows the rule
 * that nothing about the household's money happens without them saying so,
 * and a page that reloads itself mid-edit breaks it.
 *
 * So the new worker waits, and this says so. The bar is not dismissable by
 * accident - there is a "Later" - and it comes back on the next load, because
 * a version that stays unloaded forever is its own problem.
 */
import { useRegisterSW } from "virtual:pwa-register/react";
import "./UpdateReady.css";

export function UpdateReady(): React.JSX.Element | null {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_url, registration) {
      // Look for a new build when the app is reopened, which for this
      // household is several times a day. The browser also checks on its own
      // schedule; this just makes "I pushed a fix" reach them sooner.
      if (!registration) return;
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") void registration.update();
      });
    },
  });

  if (!needRefresh) return null;

  return (
    <div className="update-ready" role="status">
      <p className="update-ready__words">
        <strong>A new version of Headroom is ready.</strong> Reloading takes a second and loses
        nothing you have saved.
      </p>
      <div className="update-ready__actions">
        <button
          className="hr-button hr-button--secondary update-ready__later"
          type="button"
          onClick={() => setNeedRefresh(false)}
        >
          Later
        </button>
        <button
          className="hr-button"
          type="button"
          onClick={() => void updateServiceWorker(true)}
        >
          Reload
        </button>
      </div>
    </div>
  );
}
