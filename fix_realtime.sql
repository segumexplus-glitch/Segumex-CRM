-- Enable REPLICA IDENTITY for reliable updates/deletes
ALTER TABLE public.comm_conversations REPLICA IDENTITY FULL;
ALTER TABLE public.comm_messages REPLICA IDENTITY FULL;

-- Add tables to the realtime publication
-- (If publication doesn't exist, create it, but in Supabase it usually exists)
-- We use "add table" to be safe.

BEGIN;
  -- Try to create publication if not exists (standard Supabase setup)
  -- If it fails because it exists, we ignore.
  -- Actually, "alter publication ... add table" is the standard way.
  
  ALTER PUBLICATION supabase_realtime ADD TABLE public.comm_conversations;
  ALTER PUBLICATION supabase_realtime ADD TABLE public.comm_messages;
COMMIT;
