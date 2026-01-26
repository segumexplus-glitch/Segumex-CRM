-- Attempt to fix missing foreign key which causes Join errors in Supabase SDK
-- We use a DO block to avoid errors if it already exists

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'comm_conversations_lead_id_fkey') THEN
        ALTER TABLE comm_conversations 
        ADD CONSTRAINT comm_conversations_lead_id_fkey 
        FOREIGN KEY (lead_id) REFERENCES leads(id)
        ON DELETE SET NULL;
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE NOTICE 'Error adding FK (likely type mismatch or already exists): %', SQLERRM;
END $$;
