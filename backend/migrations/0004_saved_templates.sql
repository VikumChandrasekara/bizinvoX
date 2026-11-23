-- Pro users can save the look they built as a named template ("My templates").
-- Templates the editor manages itself (one per built-in design the user has used) keep saved = false,
-- so a saved template can never be mistaken for, or overwritten by, those.
ALTER TABLE templates ADD COLUMN saved boolean NOT NULL DEFAULT false;
CREATE INDEX templates_user_saved_idx ON templates (user_id, updated_at DESC) WHERE saved;
