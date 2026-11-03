/** Leaves the app for another site (a payment page). One place, so tests can intercept it. */
export function redirectTo(url: string): void {
  window.location.assign(url);
}
