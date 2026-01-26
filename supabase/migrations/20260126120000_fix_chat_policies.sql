-- Ensure Authenticated users (agents) can view all conversations and messages
-- comm_conversations
alter table comm_conversations enable row level security;

create policy "Agents can view all conversations"
  on comm_conversations
  for select
  using (auth.role() = 'authenticated');

create policy "Agents can update conversations"
  on comm_conversations
  for update
  using (auth.role() = 'authenticated');

-- comm_messages
alter table comm_messages enable row level security;

create policy "Agents can view all messages"
  on comm_messages
  for select
  using (auth.role() = 'authenticated');

create policy "Agents can insert messages"
  on comm_messages
  for insert
  with check (auth.role() = 'authenticated');

-- Also leads, just in case
alter table leads enable row level security;

create policy "Agents can view leads"
  on leads
  for select
  using (auth.role() = 'authenticated');
