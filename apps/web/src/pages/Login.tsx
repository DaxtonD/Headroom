/**
 * Sign in.
 *
 * Real `<form>`, real `<label>`, real `<button>` so it works with a password
 * manager, the phone keyboard's Go key, and a screen reader (HANDOFF
 * section 15 / the M5 accessibility criteria).
 */
import { useId, useState } from "react";
import { ApiError, OfflineError } from "../lib/api.js";
import { useLogin } from "../lib/session.js";
import "./Login.css";

export function Login(): React.JSX.Element {
  const emailId = useId();
  const passwordId = useId();
  const errorId = useId();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const login = useLogin();

  const errorMessage = (() => {
    if (!login.error) return undefined;
    if (login.error instanceof OfflineError) return login.error.message;
    if (login.error instanceof ApiError) return login.error.message;
    return "Could not sign in. Please try again.";
  })();

  const onSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (login.isPending) return;
    login.mutate({ email: email.trim(), password });
  };

  return (
    <main className="login">
      <div className="login__card hr-card">
        <header className="login__header">
          <p className="login__eyebrow">Headroom</p>
          <h1 className="login__title">Welcome back</h1>
          <p className="login__subtitle">
            The household budget, with the adding up already done.
          </p>
        </header>

        <form className="login__form" onSubmit={onSubmit} noValidate>
          {errorMessage ? (
            <p className="hr-alert" id={errorId} role="alert">
              {errorMessage}
            </p>
          ) : null}

          <div className="hr-field">
            <label className="hr-label" htmlFor={emailId}>
              Email
            </label>
            <input
              className="hr-input"
              id={emailId}
              name="email"
              type="email"
              inputMode="email"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={login.isError ? true : undefined}
              aria-describedby={errorMessage ? errorId : undefined}
              disabled={login.isPending}
            />
          </div>

          <div className="hr-field">
            <label className="hr-label" htmlFor={passwordId}>
              Password
            </label>
            <input
              className="hr-input"
              id={passwordId}
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={login.isError ? true : undefined}
              aria-describedby={errorMessage ? errorId : undefined}
              disabled={login.isPending}
            />
          </div>

          <button className="hr-button login__submit" type="submit" disabled={login.isPending}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="login__footnote">
          Accounts are set up on the server. If you cannot get in, ask Dax to reset your password.
        </p>
      </div>
    </main>
  );
}
