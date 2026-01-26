-- Enable REPLICA IDENTITY FULL for correct replication of updates/deletes
ALTER TABLE public.comm_conversations REPLICA IDENTITY FULL;
ALTER TABLE public.comm_messages REPLICA IDENTITY FULL;

-- Add tables to the publication
-- We use a safe approach by checking if the table is already in the publication is hard in raw SQL without PL/pgSQL
-- But 'ALTER PUBLICATION ... ADD TABLE' throws error if already added, 
-- so let's use a DO block to handle it safely or just ignore error via IF NOT EXISTS approach isn't directly supported for ADD TABLE

DO $$
BEGIN
    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.comm_conversations;
    EXCEPTION WHEN duplicate_object THEN
        RAISE NOTICE 'Table comm_conversations already in publication';
    END;

    BEGIN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.comm_messages;
    EXCEPTION WHEN duplicate_object THEN
        RAISE NOTICE 'Table comm_messages already in publication';
    END;
END $$;
