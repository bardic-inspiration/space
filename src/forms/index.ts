// The instrument forms of v1: a map, which the others stand on, and tokens,
// chips and cards. A fifth form is a module and a line here.

import { cardsForm } from './cards.ts';
import { chipsForm } from './chips.ts';
import type { ContainerForm, Form } from './form.ts';
import { mapForm } from './map.ts';
import { tokenForm } from './token.ts';

// Each form has its own binding and item type; the board and the log hold them only as `Form`.
export const FORMS: Record<string, Form> = Object.fromEntries(
  ([mapForm, tokenForm, chipsForm, cardsForm] as unknown as Form[]).map((form) => [form.id, form]),
);

export const isContainer = (form: Form): form is ContainerForm => form.role === 'container';
export { mapForm };
export * from './form.ts';
