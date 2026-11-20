import { useLayoutEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from "react";
import { applySuggestion, suggestContacts, tokenAtCaret } from "../../shared/addressCompletion.ts";
import { parseAddresses } from "../../shared/composeModel.ts";
import type { RecentContact } from "../../shared/ipcContract.ts";

export interface AddressInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "id" | "role"> {
  id: string;
  value: string;
  onChange: (value: string) => void;
  contacts: readonly RecentContact[];
}

/** "today", "3d ago", "5mo ago" -- enough to tell a regular from a one-off. */
function ago(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000);
  if (!Number.isFinite(days) || days < 1) return "today";
  if (days < 60) return `${days}d ago`;
  if (days < 730) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * A recipient field that suggests people the operator has traffic with.
 *
 * Still a plain text field underneath: the suggestions only ever complete the
 * address under the caret, so typing, pasting and editing a list by hand all
 * behave exactly as they did. Nothing is turned into chips, because the field's
 * text is what Pat parses and the operator should be able to see all of it.
 */
export function AddressInput({ id, value, onChange, contacts, ...inputProps }: AddressInputProps) {
  const input = useRef<HTMLInputElement>(null);
  const pendingCaret = useRef<number | null>(null);
  const [caret, setCaret] = useState(value.length);
  const [open, setOpen] = useState(false);
  // ArrowDown in an empty token lists the most recent contacts; typing alone
  // never opens the list on nothing.
  const [showAll, setShowAll] = useState(false);
  const [active, setActive] = useState(0);

  const token = tokenAtCaret(value, caret);
  // Everything but the address being typed, so finishing "W1A" into W1AW is
  // not blocked by W1AW counting as already present.
  const present = parseAddresses(value.slice(0, token.start) + " " + value.slice(token.end));
  const suggestions =
    open && (token.text || showAll) ? suggestContacts(contacts, token.text, present) : [];
  const visible = suggestions.length > 0;
  const highlighted = Math.min(active, suggestions.length - 1);

  // The caret has to move after React has written the new value, or the
  // browser puts it at the end of the field.
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !input.current) return;
    input.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  });

  const listId = `${id}-suggestions`;
  const optionId = (index: number) => `${id}-suggestion-${index}`;

  function accept(contact: RecentContact) {
    const next = applySuggestion(value, token, contact.address);
    pendingCaret.current = next.caret;
    setCaret(next.caret);
    setOpen(false);
    onChange(next.value);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!visible) {
        setOpen(true);
        setShowAll(true);
        setActive(0);
      } else {
        setActive((highlighted + 1) % suggestions.length);
      }
      return;
    }
    if (!visible) return;

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((highlighted - 1 + suggestions.length) % suggestions.length);
    } else if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      accept(suggestions[highlighted]!);
    } else if (event.key === "Escape") {
      // Closes the list, not the window it sits in.
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  return (
    <div className="address-complete">
      <input
        {...inputProps}
        ref={input}
        id={id}
        className="field__input"
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={listId}
        aria-activedescendant={visible ? optionId(highlighted) : undefined}
        onChange={(event) => {
          setCaret(event.target.selectionStart ?? event.target.value.length);
          setOpen(true);
          setShowAll(false);
          setActive(0);
          onChange(event.target.value);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? value.length)}
        onKeyDown={onKeyDown}
        onBlur={() => setOpen(false)}
      />
      {visible ? (
        <ul className="address-complete__menu" role="listbox" id={listId} aria-label="Recent recipients">
          {suggestions.map((contact, index) => (
            <li
              key={contact.address}
              id={optionId(index)}
              role="option"
              aria-selected={index === highlighted}
              className={`address-complete__option${index === highlighted ? " address-complete__option--active" : ""}`}
              // mousedown, not click: a click would blur the field first, and
              // the blur closes the list before the click lands.
              onMouseDown={(event) => {
                event.preventDefault();
                accept(contact);
              }}
              onMouseEnter={() => setActive(index)}
            >
              <span className="address-complete__address">{contact.address}</span>
              <span className="address-complete__meta">{ago(contact.lastUsed)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
