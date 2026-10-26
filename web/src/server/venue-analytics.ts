import "server-only";
import { sql } from "drizzle-orm";
import type { DomainDb } from "./db-scoped";

export type VenueAnalytics = {
  period: { days: 7 | 30; timezone: string; start: string; end: string; refreshedAt: string };
  summary: {
    attemptStarted: number; attemptCompleted: number; completionRate: number | null;
    soloStarted: number; soloCompleted: number; duoStarted: number; duoCompleted: number;
    duoGroupsStarted: number; duoGroupsFullyCompleted: number; feedbackCount: number;
    averageRating: number | null; ratings: Record<"1" | "2" | "3" | "4" | "5", number>;
  };
  versions: Array<{ versionNo: number; title: string; attemptStarted: number; attemptCompleted: number; feedbackCount: number }>;
};

export async function getVenueAnalytics(db: DomainDb, venueId: string, options: { days: 7 | 30; asOf?: Date }): Promise<VenueAnalytics> {
  const asOf = options.asOf ?? new Date();
  const result = await db.execute(sql`
    WITH venue AS (
      SELECT id, timezone FROM venues WHERE id = ${venueId}::uuid
    ), bounds AS (
      SELECT timezone, ${asOf}::timestamptz AS ends_at,
        ((((${asOf}::timestamptz AT TIME ZONE timezone)::date - (${options.days} - 1))::timestamp) AT TIME ZONE timezone) AS starts_at
      FROM venue
    ), attempt_cohort AS (
      SELECT a.id, a.publication_id, a.play_group_id, a.mode, a.status, a.consented_at
      FROM attempts a
      JOIN publications p ON p.id = a.publication_id AND p.venue_id = ${venueId}::uuid
      CROSS JOIN bounds b
      WHERE a.started_at >= b.starts_at AND a.started_at < b.ends_at
    ), attempt_totals AS (
      SELECT count(*)::int AS started,
        count(*) FILTER (WHERE status = 'completed')::int AS completed,
        count(*) FILTER (WHERE mode = 'solo')::int AS solo_started,
        count(*) FILTER (WHERE mode = 'solo' AND status = 'completed')::int AS solo_completed,
        count(*) FILTER (WHERE mode = 'duo')::int AS duo_started,
        count(*) FILTER (WHERE mode = 'duo' AND status = 'completed')::int AS duo_completed
      FROM attempt_cohort
    ), group_cohort AS (
      SELECT g.id FROM play_groups g CROSS JOIN bounds b
      WHERE g.venue_id = ${venueId}::uuid AND g.created_at >= b.starts_at AND g.created_at < b.ends_at
    ), group_totals AS (
      SELECT count(*)::int AS started,
        count(*) FILTER (WHERE COALESCE(member_stats.member_count, 0) = 2 AND member_stats.completed_count = 2)::int AS completed
      FROM group_cohort gc
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE a.mode = 'duo' AND a.consented_at IS NOT NULL)::int AS member_count,
          count(*) FILTER (WHERE a.mode = 'duo' AND a.consented_at IS NOT NULL AND a.status = 'completed')::int AS completed_count
        FROM attempts a WHERE a.play_group_id = gc.id
      ) member_stats ON true
    ), feedback_totals AS (
      SELECT count(*)::int AS total, round(avg(f.rating)::numeric, 1)::float8 AS average,
        count(*) FILTER (WHERE f.rating = 1)::int AS r1, count(*) FILTER (WHERE f.rating = 2)::int AS r2,
        count(*) FILTER (WHERE f.rating = 3)::int AS r3, count(*) FILTER (WHERE f.rating = 4)::int AS r4,
        count(*) FILTER (WHERE f.rating = 5)::int AS r5
      FROM feedback f JOIN attempt_cohort ac ON ac.id = f.attempt_id
    ), version_attempts AS (
      SELECT v.id AS version_id, v.version_no,
        COALESCE(v.content->>'title', t.title) AS title,
        count(ac.id)::int AS started,
        count(ac.id) FILTER (WHERE ac.status = 'completed')::int AS completed
      FROM activity_versions v
      JOIN activity_templates t ON t.id = v.template_id AND t.venue_id = ${venueId}::uuid
      JOIN publications p ON p.version_id = v.id AND p.venue_id = ${venueId}::uuid
      JOIN attempt_cohort ac ON ac.publication_id = p.id
      WHERE v.venue_id = ${venueId}::uuid
      GROUP BY v.id, v.version_no, v.content, t.title
    ), version_feedback AS (
      SELECT p.version_id, count(f.id)::int AS feedback_count
      FROM feedback f
      JOIN attempt_cohort ac ON ac.id = f.attempt_id
      JOIN publications p ON p.id = ac.publication_id AND p.venue_id = ${venueId}::uuid
      GROUP BY p.version_id
    ), versions AS (
      SELECT va.version_id, va.version_no, va.title, va.started, va.completed, COALESCE(vf.feedback_count, 0)::int AS feedback_count
      FROM version_attempts va LEFT JOIN version_feedback vf ON vf.version_id = va.version_id
    )
    SELECT b.timezone, b.starts_at::text AS starts_at, b.ends_at::text AS ends_at,
      at.started, at.completed, at.solo_started, at.solo_completed, at.duo_started, at.duo_completed,
      gt.started AS groups_started, gt.completed AS groups_completed,
      ft.total AS feedback_count, ft.average AS average_rating,
      ft.r1, ft.r2, ft.r3, ft.r4, ft.r5,
      COALESCE(version_data.items, '[]'::jsonb) AS versions
    FROM bounds b CROSS JOIN attempt_totals at CROSS JOIN group_totals gt CROSS JOIN feedback_totals ft
    CROSS JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('versionNo', version_no, 'title', title, 'attemptStarted', started, 'attemptCompleted', completed, 'feedbackCount', feedback_count) ORDER BY version_no) AS items FROM versions) version_data
  `);
  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows;
  const row = rows[0];
  if (!row) throw new Error("Venue not found");
  const integer = (key: string) => Number(row[key] ?? 0);
  const started = integer("started");
  const versions = row.versions as VenueAnalytics["versions"] | string;
  return {
    period: { days: options.days, timezone: String(row.timezone), start: String(row.starts_at), end: String(row.ends_at), refreshedAt: asOf.toISOString() },
    summary: {
      attemptStarted: started, attemptCompleted: integer("completed"), completionRate: started ? integer("completed") / started : null,
      soloStarted: integer("solo_started"), soloCompleted: integer("solo_completed"), duoStarted: integer("duo_started"), duoCompleted: integer("duo_completed"),
      duoGroupsStarted: integer("groups_started"), duoGroupsFullyCompleted: integer("groups_completed"), feedbackCount: integer("feedback_count"),
      averageRating: row.average_rating === null ? null : Number(row.average_rating),
      ratings: { "1": integer("r1"), "2": integer("r2"), "3": integer("r3"), "4": integer("r4"), "5": integer("r5") },
    },
    versions: typeof versions === "string" ? JSON.parse(versions) as VenueAnalytics["versions"] : versions,
  };
}
