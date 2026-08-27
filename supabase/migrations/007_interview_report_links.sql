-- Shareable aggregate report link: exactly one active link per interview.
-- Accessed via /r/{token}; token lookup happens server-side with the service
-- role key, so RLS is enabled with no policies (anon/authenticated denied).

CREATE TABLE IF NOT EXISTS interview_report_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "interviewId" UUID NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One active link per interview (create replaces the previous row).
CREATE UNIQUE INDEX IF NOT EXISTS interview_report_links_interview_id_key
  ON interview_report_links ("interviewId");

ALTER TABLE interview_report_links ENABLE ROW LEVEL SECURITY;
