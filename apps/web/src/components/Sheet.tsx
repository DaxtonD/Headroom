/**
 * The form shell every editing sheet uses.
 *
 * It exists so that adding a new kind of thing to manage does not mean
 * re-implementing the dialog semantics — the backdrop, the labelled modal, the
 * Escape key, the error slot and the Cancel/Save pair. Each form supplies only
 * its fields.
 *
 * Deliberately a real `<form>` wrapping real inputs, so Enter submits and a
 * screen reader announces the dialog and its name.
 */
import { useOverlayDismissal } from "../lib/overlayDismissal.js";
import "./Sheet.css";

export function Sheet({
  title,
  intro,
  error,
  saving,
  saveLabel,
  onClose,
  onSubmit,
  children,
  footer,
}: {
  title: string;
  intro?: string;
  error?: string | null;
  saving: boolean;
  saveLabel: string;
  onClose: () => void;
  onSubmit: () => void | Promise<void>;
  children: React.ReactNode;
  /** A destructive action, kept away from the Cancel/Save pair. */
  footer?: React.ReactNode;
}): React.JSX.Element {
  // Cancel, Escape, Back and a tap outside - all four inert while saving.
  const backdrop = useOverlayDismissal(onClose, saving);

  return (
    /*
     * A div, not a button: this is the dark area around the sheet, and a
     * screen reader should find the dialog inside it rather than a
     * full-screen control to tab past. Tapping outside is a pointer
     * convenience on top of Cancel, Escape and Back, so nothing here is the
     * only way to do anything - which is why it does not need to be
     * reachable by keyboard itself.
     */
    <div
      className="sheet-backdrop"
      role="presentation"
      onPointerDown={backdrop.onPointerDown}
      onClick={backdrop.onClick}
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit();
          }}
        >
          <h2 className="sheet__title">{title}</h2>
          {intro ? <p className="sheet__intro">{intro}</p> : null}

          {error ? (
            <p className="hr-alert sheet__error" role="alert">
              {error}
            </p>
          ) : null}

          {children}

          <div className="sheet__actions">
            <button
              className="hr-button hr-button--secondary"
              type="button"
              onClick={onClose}
              disabled={saving}
            >
              Cancel
            </button>
            <button className="hr-button" type="submit" disabled={saving}>
              {saving ? "Saving…" : saveLabel}
            </button>
          </div>

          {footer ? <div className="sheet__danger">{footer}</div> : null}
        </form>
      </div>
    </div>
  );
}

/** A labelled field, with an optional explanation underneath. */
export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="hr-field sheet__field">
      <label className="hr-label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint ? <span className="sheet__hint">{hint}</span> : null}
    </div>
  );
}

/**
 * A remove button that asks first.
 *
 * Two presses rather than a `confirm()`: the native dialog is blocked in some
 * installed-PWA contexts, and a button that changes its own label keeps the
 * question in the same place as the answer.
 */
export function RemoveButton({
  label,
  confirmLabel,
  note,
  armed,
  disabled,
  onArm,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  note: string;
  armed: boolean;
  disabled: boolean;
  onArm: () => void;
  onConfirm: () => void;
}): React.JSX.Element {
  return (
    <>
      <button
        className="sheet__danger-button"
        type="button"
        disabled={disabled}
        onClick={() => (armed ? onConfirm() : onArm())}
      >
        {armed ? confirmLabel : label}
      </button>
      <p className="sheet__danger-note">{armed ? note : null}</p>
    </>
  );
}
