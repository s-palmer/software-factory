/** Central registries. Specs and verifiers register themselves on import. */
import type { AnyUnit, VerifiableUnit, Verifier, VerifyManifestEntry } from "./types";

const units = new Map<string, AnyUnit>();
const verifiers = new Map<string, Verifier>();

export function registerUnit<P>(unit: VerifiableUnit<P>): VerifiableUnit<P> {
  units.set(unit.id, unit); // replace on re-register (hot reload friendly)
  return unit;
}

export function unregisterUnit(id: string): void {
  units.delete(id);
}

export function registerVerifier(verifier: Verifier): Verifier {
  verifiers.set(verifier.id, verifier);
  return verifier;
}

export const getUnit = (id: string): AnyUnit | undefined => units.get(id);
export const allUnits = (): AnyUnit[] => Array.from(units.values());
export const allVerifiers = (): Verifier[] => Array.from(verifiers.values());

/** All verifiers by default, or the unit's declared subset (unknown ids are dropped). */
export function verifiersFor(unit: AnyUnit): Verifier[] {
  if (!unit.verifiers) return allVerifiers();
  return unit.verifiers.map((id) => verifiers.get(id)).filter((v): v is Verifier => v !== undefined);
}

type RouteFormat = (unitId: string, fixtureId: string) => string;

let routeFormat: RouteFormat = (unitId, fixtureId) => `/verify/${encodeURIComponent(unitId)}/${encodeURIComponent(fixtureId)}`;

/** Where one fixture mounts. An app with its own router keeps `/verify/:unit/:fixture`; a separate harness page sets its own. */
export function setRouteFormat(format: RouteFormat): void {
  routeFormat = format;
}

export function fixtureRoute(unitId: string, fixtureId: string): string {
  return routeFormat(unitId, fixtureId);
}

export function buildManifest(): VerifyManifestEntry[] {
  return allUnits().map((u) => ({
    unitId: u.id,
    title: u.title,
    kind: u.kind,
    fixtures: u.fixtures.map((f) => ({
      id: f.id,
      description: f.description,
      probe: Boolean(f.probe),
      route: fixtureRoute(u.id, f.id),
    })),
    verifiers: verifiersFor(u).map((v) => v.id),
    invariants: u.invariants.map((i) => ({ id: i.id, description: i.description })),
  }));
}
