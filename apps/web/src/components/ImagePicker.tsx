/**
 * Choosing a picture, and cropping it to the square that gets stored.
 *
 * The household asked for the crop rather than letting the app decide, and
 * they were right: a logo wants all of itself kept and a photograph wants the
 * middle of it, and only the person looking at it knows which this is.
 *
 * ## Inline, not a second dialog
 *
 * This sits inside a form that is already a modal sheet. A dialog over a
 * dialog on a phone is disorienting, and it would mean two Saves on screen
 * with different meanings. So the crop surface expands in place, and the
 * form's own Save stays the only one.
 *
 * ## The arithmetic is not here
 *
 * `lib/cropImage.ts` holds every number, as a pure function with its own
 * tests, because bugs 24 and 25 were arithmetic hidden behind a grep that
 * asserted the code said what the code said. What is left in this file is
 * event plumbing, which a source check can cover honestly.
 *
 * ## Why a data URL and not an object URL
 *
 * `URL.createObjectURL` would be the obvious choice and it is the wrong one:
 * the Content-Security-Policy allows `img-src 'self' data:` and not `blob:`,
 * so the preview would simply not render - and it would fail only in the
 * built app, never in a test. `FileReader` gives a `data:` URL that is already
 * allowed.
 *
 * ## Why the zoom is a slider and not a pinch
 *
 * A slider is one pointer, is keyboard-operable, has a 44px target, and does
 * not fight the browser's own pinch-to-zoom on the page around it. Two-finger
 * tracking inside a scrolling sheet is a lot of behaviour to get right for a
 * control that is used for about four seconds.
 */
import { useId, useRef, useState } from "react";
import { Thumb } from "./Thumb.js";
import {
  clampPan,
  displayedSize,
  encodeCrop,
  imageOffset,
  MAX_SCALE,
  type CropView,
} from "../lib/cropImage.js";
import { ApiError, OfflineError } from "../lib/api.js";
import { useUploadImage } from "../lib/queries.js";
import "./ImagePicker.css";

/**
 * The side of the crop surface, in CSS pixels.
 *
 * Declared here and applied as an inline style rather than left to the
 * stylesheet, because the crop arithmetic needs this exact number. Two places
 * holding it would be two numbers that could drift, and the symptom would be
 * a crop that does not match what was on screen.
 *
 * 240 so it fits a 320px phone inside the sheet's own padding.
 */
const VIEWPORT = 240;

/** How far one arrow-key press moves the picture. */
const NUDGE = 12;

export function ImagePicker({
  value,
  onChange,
  disabled = false,
}: {
  /** The image id currently set, or null. */
  readonly value: string | null;
  readonly onChange: (imageId: string | null) => void;
  readonly disabled?: boolean;
}): React.JSX.Element {
  const upload = useUploadImage();
  const ids = { file: useId(), zoom: useId() };

  /** The chosen file as a `data:` URL, while it is being cropped. */
  const [source, setSource] = useState<string | null>(null);
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ offsetX: 0, offsetY: 0 });
  const [error, setError] = useState<string | null>(null);

  const imageRef = useRef<HTMLImageElement | null>(null);
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    fromX: number;
    fromY: number;
  } | null>(null);

  const view: CropView = {
    sourceWidth: natural?.width ?? 0,
    sourceHeight: natural?.height ?? 0,
    viewport: VIEWPORT,
    scale,
    offsetX: pan.offsetX,
    offsetY: pan.offsetY,
  };

  const closeCrop = (): void => {
    setSource(null);
    setNatural(null);
    setScale(1);
    setPan({ offsetX: 0, offsetY: 0 });
    drag.current = null;
  };

  const choose = (file: File | undefined): void => {
    setError(null);
    if (!file) return;

    /*
     * A sanity bound on what is read into memory, not a bound on what is
     * stored - the crop re-encodes to about 15KB whatever goes in. A modern
     * phone photograph is 3 to 12MB, so this only refuses something that was
     * never a photograph.
     */
    if (file.size > 32 * 1024 * 1024) {
      setError("That file is very large. Try a photo or a logo rather than a full-size image.");
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => setError("That file could not be read. Try another one.");
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : null;
      if (result === null || !result.startsWith("data:image/")) {
        setError("That does not look like a picture.");
        return;
      }
      setScale(1);
      setPan({ offsetX: 0, offsetY: 0 });
      setSource(result);
    };
    reader.readAsDataURL(file);
  };

  const move = (nextX: number, nextY: number): void => {
    setPan(clampPan({ ...view, offsetX: nextX, offsetY: nextY }));
  };

  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (natural === null) return;
    // Capture, so a finger that leaves the square still drags it.
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      fromX: pan.offsetX,
      fromY: pan.offsetY,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLButtonElement>): void => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    move(
      current.fromX + (event.clientX - current.startX),
      current.fromY + (event.clientY - current.startY),
    );
  };

  const onPointerUp = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const nudges: Record<string, readonly [number, number]> = {
      ArrowLeft: [-NUDGE, 0],
      ArrowRight: [NUDGE, 0],
      ArrowUp: [0, -NUDGE],
      ArrowDown: [0, NUDGE],
    };
    const nudge = nudges[event.key];
    if (!nudge) return;

    // Or the page scrolls behind the crop surface instead.
    event.preventDefault();
    move(pan.offsetX + nudge[0], pan.offsetY + nudge[1]);
  };

  const zoomTo = (next: number): void => {
    setScale(next);
    // Zooming out can leave the picture short of an edge, so the pan has to
    // come back inside the new limits rather than wait to be dragged.
    setPan(clampPan({ ...view, scale: next }));
  };

  const use = async (): Promise<void> => {
    setError(null);
    const element = imageRef.current;
    if (element === null || natural === null) return;

    try {
      const base64 = encodeCrop(element, view);
      const created = await upload.mutateAsync({ base64 });
      onChange(created.image.id);
      closeCrop();
    } catch (caught) {
      if (caught instanceof OfflineError || caught instanceof ApiError) setError(caught.message);
      else if (caught instanceof Error) setError(caught.message);
      else setError("That picture could not be saved. Please try again.");
    }
  };

  const busy = disabled || upload.isPending;

  return (
    <div className="picker">
      <span className="hr-label" id={`${ids.file}-label`}>
        Picture
      </span>

      {source === null ? (
        <div className="picker__current">
          <Thumb imageId={value} size="picker" />

          {/*
            A real file input, visually transparent over its own label, so the
            whole button area is the control rather than a button that pokes a
            hidden input. Keyboard focus and the 44px target come for free.
          */}
          <label className="picker__choose" htmlFor={ids.file}>
            <span>{value === null ? "Add a picture" : "Change picture"}</span>
            <input
              className="picker__file"
              id={ids.file}
              type="file"
              accept="image/*"
              disabled={busy}
              onChange={(event) => {
                choose(event.target.files?.[0]);
                // Cleared, so choosing the same file twice still fires.
                event.target.value = "";
              }}
            />
          </label>

          {value === null ? null : (
            <button
              className="hr-button hr-button--secondary picker__remove"
              type="button"
              disabled={busy}
              onClick={() => {
                setError(null);
                onChange(null);
              }}
            >
              Remove
            </button>
          )}
        </div>
      ) : (
        <div className="picker__crop">
          <p className="picker__hint">Drag to move it, and use the slider to zoom.</p>

          {/*
            `touch-action: none` in the stylesheet is what makes dragging work
            at all on a phone - without it the browser scrolls the sheet
            instead and the picture never moves.
          */}
          {/*
            A real `<button>`, after two goes at dressing a `<div>` up as one.

            `role="group"` and then `role="application"` were both refused, and
            the linter was right both times: a thing you focus and drive with
            the arrow keys is a control, and the way to say that is to use a
            control. A button is focusable, takes pointer and key events, and
            is announced as something you can operate.

            It has no `onClick`, so Enter and Space do nothing - which is
            correct. The label is what carries the instructions, since there is
            nothing else for a screen reader to go on.
          */}
          <button
            className="picker__viewport"
            type="button"
            style={{ width: VIEWPORT, height: VIEWPORT }}
            aria-label="Crop the picture. Drag it, or move it with the arrow keys." 
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
          >
            <img
              className="picker__source"
              ref={imageRef}
              src={source}
              alt=""
              draggable={false}
              style={cropStyle(view)}
              onLoad={(event) => {
                const element = event.currentTarget;
                setNatural({
                  width: element.naturalWidth,
                  height: element.naturalHeight,
                });
              }}
            />
          </button>

          <div className="picker__zoom">
            <label className="hr-label" htmlFor={ids.zoom}>
              Zoom
            </label>
            <input
              className="picker__slider"
              id={ids.zoom}
              type="range"
              min={1}
              max={MAX_SCALE}
              step={0.01}
              value={scale}
              disabled={busy || natural === null}
              onChange={(event) => zoomTo(Number(event.target.value))}
            />
          </div>

          <div className="picker__actions">
            <button
              className="hr-button"
              type="button"
              disabled={busy || natural === null}
              onClick={() => void use()}
            >
              {upload.isPending ? "Saving…" : "Use this picture"}
            </button>
            <button
              className="hr-button hr-button--secondary"
              type="button"
              disabled={upload.isPending}
              onClick={() => {
                setError(null);
                closeCrop();
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error === null ? null : (
        <p className="picker__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Where the picture sits inside the square, as CSS.
 *
 * Every number comes from `cropImage.ts` - the same two functions the crop
 * itself is computed from - so what is on screen and what gets stored cannot
 * disagree. The first draft of this re-derived the position here instead,
 * which is the mistake that caused bugs 24 and 25 twice over: two copies of
 * one piece of arithmetic, one of them untested.
 *
 * Plain `left`/`top`/`width`/`height` rather than a transform, because those
 * are the terms the pure functions already answer in.
 */
function cropStyle(view: CropView): React.CSSProperties {
  if (view.sourceWidth <= 0 || view.sourceHeight <= 0) return { visibility: "hidden" };

  const { width, height } = displayedSize(view);
  const { left, top } = imageOffset(view);
  return { width, height, left, top };
}
