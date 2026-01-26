-- Force RLS Policies for Chat and Leads
-- Use DO block or IF NOT EXISTS logic to avoid errors

-- 1. Channels
alter table comm_channels enable row level security;
drop policy if exists "Enable read access for all users" on comm_channels;
create policy "Enable read access for all users" on comm_channels for select using (true);

-- 2. Conversations
alter table comm_conversations enable row level security;
drop policy if exists "Enable read access for all users" on comm_conversations;
create policy "Enable read access for all users" on comm_conversations for select using (true);

drop policy if exists "Enable insert/update for authenticated" on comm_conversations;
create policy "Enable insert/update for authenticated" on comm_conversations for all using (auth.role() = 'authenticated');

-- 3. Messages
alter table comm_messages enable row level security;
drop policy if exists "Enable read access for all users" on comm_messages;
create policy "Enable read access for all users" on comm_messages for select using (true);

drop policy if exists "Enable insert for authenticated" on comm_messages;
create policy "Enable insert for authenticated" on comm_messages for insert with check (auth.role() = 'authenticated');

-- 4. Leads (Critical for Join)
alter table leads enable row level security;
drop policy if exists "Enable read access for all users" on leads;
create policy "Enable read access for all users" on leads for select using (true);

-- 5. Foreign Keys Adjustment (Optional correctness check)
-- This part is tricky without knowing exact types, but let's assume if it fails it fails.
-- We won't alter FK logic here to avoid corruption, just permissions.
