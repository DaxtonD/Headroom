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
import { useEffect, useRef } from "react";
import { useBackDismiss } from "../lib/backDismiss.js";
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
/**
 * Did this click's press begin on the backdrop itself?
 *
 * A `click` is dispatched on the nearest common ancestor of where the pointer
 * went down and where it came up. Select some text in the sheet, drag past its
 * edge and release, and that ancestor is the backdrop - so a plain
 * `onClick={onClose}` threw the form away mid-selection, losing whatever had
 * been typed. `stopPropagation` on the sheet cannot help: the sheet is not in
 * that event's path at all.
 *
 * So the press has to have started on the backdrop too. A deliberate click
 * outside still closes; a selection that merely ends outside does not.
 */
  const pressedBackdrop = useRef(false);

  // Android's Back closes the sheet rather than leaving the screen. Inert
  // while saving, for the same reason Escape is: a request is in flight.
  useBackDismiss(true, onClose, saving);

  // Escape closes, as it does for any dialog. Not registered while saving: a
  // request is already in flight and closing would hide its outcome.
  useEffect(() => {
    if (saving) return undefined;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saving, onClose]);

  return (
    <div
      className="sheet-backdrop"
      onPointerDown={(event) => {
        pressedBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const fromBackdrop =
          pressedBackdrop.current && event.target === event.currentTarget;
        pressedBackdrop.current = false;
        if (fromBackdrop && !saving) onClose();
      }}
      role="presentation"
    >
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
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
