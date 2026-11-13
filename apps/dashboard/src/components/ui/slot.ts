import { isValidElement, type ReactElement } from "react";

/**
 * The element an `asChild` wrapper renders in place of its own, passed to a ui-sdk `render`
 * prop. The part merges its props, handlers and ref into that element. Returns undefined when
 * `asChild` is off or the child is not a single element, and the wrapper renders its own tag.
 */
export function asChildElement(
  asChild: boolean,
  children: unknown,
): ReactElement<Record<string, unknown>> | undefined {
  return asChild && isValidElement<Record<string, unknown>>(children) ? children : undefined;
}
