/**
 * "There is a new version" - a bar, not a reload.
 *
 * A service worker set to update itself activates the moment it finishes
 * downloading, which can swap the code under somebody halfway through typing
 * a balance into. Everything else in this app follows the rule that nothing
 * about the household's money happens without them saying so, and a page that
 * reloads itself mid-edit breaks it.
 *
 * So the new worker waits, and this says so. The bar is not dismissable by
 * accident - there is a "Later" - and it comes back on the next load, because
 * a version that stays unloaded forever is its own problem.
 *
 * ## Two ways of finding out, because one of them failed
 *
 * The service worker route is the first: the worker notices a new build,
 * installs it, parks it in `waiting`, and `needRefresh` becomes true. That is
 * the path this file was originally written for, and when it works it is the
 * better one - the new bundle is already downloaded before anyone is asked.
 *
 * It stopped working on a deployed install. A new image was pulled and
 * running, the server was serving the new bundle to any browser that asked,
 * and the installed app went on serving the old one with no bar, no error and
 * no way to tell from the inside. Reported as "the PWA doesn't update when
 * the new version is pulled and running", and confirmed by the new build
 * appearing correctly in a browser that had never opened the app before.
 *
 * So there is a second route that shares none of the first one's machinery:
 * ask the server what build it is and compare it with this bundle's own stamp
 * (`lib/serverBuild.ts`). If they differ, this bundle is out of date, whatever
 * the worker believes. The reload that follows forces the issue rather than
 * politely asking a worker that has already proved it will not answer.
 *
 * A stale build is reported more firmly than a waiting one, because by then
 * the app is not merely behind - it is behind and the mechanism that was
 * supposed to say so did not.
 */
import { useRegisterSW } from "virtual:pwa-register/react";
import { loadServerBuild, useServerBuild } from "../lib/serverBuild.js";
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

  const { stale } = useServerBuild();

  // The firmer message wins: being stale means the worker route already
  // failed, so saying "a new version is ready" would understate it.
  if (stale) {
    return (
      <div className="update-ready update-ready--stale" role="alert">
        <p className="update-ready__words">
          <strong>This app is out of date.</strong> The server is running a newer version than
          this one. Reloading takes a second and loses nothing you have saved.
        </p>
        <div className="update-ready__actions">
          <button className="hr-button" type="button" onClick={() => void loadServerBuild()}>
            Reload
          </button>
        </div>
      </div>
    );
  }

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
        <button className="hr-button" type="button" onClick={() => void updateServiceWorker(true)}>
          Reload
        </button>
      </div>
    </div>
  );
}
