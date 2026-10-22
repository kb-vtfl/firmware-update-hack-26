import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OUTPUT_DIR } from "./config.js";
import type { Ticket } from "./types.js";

/** Local stand-in for the ticketing system: tickets are appended to output/tickets.json. */
const TICKETS_FILE = join(OUTPUT_DIR, "tickets.json");

async function readTickets(): Promise<Ticket[]> {
  try {
    return JSON.parse(await readFile(TICKETS_FILE, "utf8")) as Ticket[];
  } catch {
    return [];
  }
}

export async function createTicket(input: Omit<Ticket, "id" | "createdAt">): Promise<Ticket> {
  const createdAt = new Date();
  const ticket: Ticket = {
    id: `TCK-${input.stationId}-${createdAt.getTime()}`,
    createdAt: createdAt.toISOString(),
    ...input,
  };
  await mkdir(OUTPUT_DIR, { recursive: true });
  const tickets = await readTickets();
  tickets.push(ticket);
  await writeFile(TICKETS_FILE, JSON.stringify(tickets, null, 2) + "\n", "utf8");
  return ticket;
}
