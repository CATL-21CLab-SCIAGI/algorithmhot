-- Existing batches retain NULL, meaning their original environment route. A new batch records
-- the exact selected model profile at INSERT; changing the setting never rewrites a batch.
ALTER TABLE research_runs ADD COLUMN model_profile jsonb;
ALTER TABLE research_runs ADD CONSTRAINT research_runs_model_profile_check CHECK (
  model_profile IS NULL OR (
    jsonb_typeof(model_profile) = 'object'
    AND model_profile ?& ARRAY['version','profileId','transport','model','reasoningEffort','region']
    AND model_profile->'version' = '1'::jsonb
    AND model_profile->>'profileId' IN ('codex-gpt-6-astra','codex-gpt-6.1-sol','bedrock-gpt-6-astra')
    AND model_profile->>'transport' IN ('codex_cli','bedrock_converse')
  )
);

-- Service limits are additional to the shared, persistent daily model_runs allowance (<=600).
-- These are application-call limits, not a dollar spending limit or an authorization to call.
INSERT INTO budgets (service,per_minute,per_hour,per_day,note)
VALUES ('bedrock_converse',60,600,600,'Bedrock 按量付费；应用调用数另受共享 model_runs 约束，不表示美元费用上限')
ON CONFLICT (service) DO NOTHING;
