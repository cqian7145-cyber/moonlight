import { createFeedbackApiHandlers } from "@/server/feedback-api";
const handlers = createFeedbackApiHandlers();
export function GET(request: Request) { return handlers.duoGet(request); }
export function POST(request: Request) { return handlers.duoPost(request); }
