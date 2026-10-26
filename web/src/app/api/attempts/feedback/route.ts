import { createFeedbackApiHandlers } from "@/server/feedback-api";
const handlers = createFeedbackApiHandlers();
export function GET(request: Request) { return handlers.soloGet(request); }
export function POST(request: Request) { return handlers.soloPost(request); }
