/**
 * @headroom/core - the shared calculation engine.
 *
 * Pure functions only: no I/O, no database, no `Date.now()`. Every derived
 * number in Headroom (running balances, lowest point, safe to spend, coverage,
 * left this cycle, pay periods, budget shares, net worth, retirement) is
 * computed here, so the web app and the API can never disagree.
 *
 * Nothing derived is ever stored. Facts go in the database; totals come from
 * this module.
 */

export const CORE_VERSION = "0.1.0";

export * from "./money.js";
