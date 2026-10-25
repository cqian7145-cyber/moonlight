import { createAttemptApiHandlers } from "@/server/attempt-api";

const handlers = createAttemptApiHandlers();

export async function POST(request: Request): Promise<Response> {
  return handlers.answer(request);
}
