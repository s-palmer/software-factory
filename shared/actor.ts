/** Who is calling the API: a person (the default) or a named agent. See docs/INTERFACE.md. */
import { z } from "zod";

export const ACTOR_HEADER = "x-factory-actor";

export const ActorSchema = z
  .string()
  .regex(/^(human|agent:[a-z0-9][a-z0-9-]{0,39})$/, 'Actor must be "human" or "agent:<name>" (lowercase letters, digits, dashes)');
export type Actor = z.infer<typeof ActorSchema>;

export function isAgent(actor: Actor): boolean {
  return actor.startsWith("agent:");
}
