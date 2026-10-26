ALTER TABLE "activity_templates" DROP CONSTRAINT "activity_templates_draft_content_shape";--> statement-breakpoint
ALTER TABLE "activity_templates" ADD CONSTRAINT "activity_templates_draft_content_shape" CHECK ("activity_templates"."draft_content" IS NULL OR (
    jsonb_typeof("activity_templates"."draft_content") = 'object' AND
    CASE WHEN jsonb_typeof("activity_templates"."draft_content" -> 'title') = 'string'
      AND length(trim("activity_templates"."draft_content" ->> 'title')) > 0
      AND jsonb_typeof("activity_templates"."draft_content" -> 'cues') = 'array'
    THEN jsonb_array_length("activity_templates"."draft_content" -> 'cues') = 3
    ELSE false END
  ));