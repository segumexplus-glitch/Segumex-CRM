-- 1. Create Knowledge Docs Table
CREATE TABLE IF NOT EXISTS public.knowledge_docs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    title TEXT NOT NULL,
    file_url TEXT,
    extracted_text TEXT, -- The content we will feed to the AI
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Enable RLS
ALTER TABLE public.knowledge_docs ENABLE ROW LEVEL SECURITY;

-- 3. Policies for Knowledge Docs (Auth users can read/write)
CREATE POLICY "Enable read access for authenticated users" ON public.knowledge_docs
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "Enable insert access for authenticated users" ON public.knowledge_docs
    FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Enable update access for authenticated users" ON public.knowledge_docs
    FOR UPDATE TO authenticated USING (true);

CREATE POLICY "Enable delete access for authenticated users" ON public.knowledge_docs
    FOR DELETE TO authenticated USING (true);

-- 4. Create Storage Bucket 'knowledge' (if not exists)
INSERT INTO storage.buckets (id, name, public)
VALUES ('knowledge', 'knowledge', true)
ON CONFLICT (id) DO NOTHING;

-- 5. Storage Policies
CREATE POLICY "Public Access" ON storage.objects
    FOR SELECT USING (bucket_id = 'knowledge');

CREATE POLICY "Auth Upload" ON storage.objects
    FOR INSERT TO authenticated WITH CHECK (bucket_id = 'knowledge');

CREATE POLICY "Auth Update" ON storage.objects
    FOR UPDATE TO authenticated USING (bucket_id = 'knowledge');

CREATE POLICY "Auth Delete" ON storage.objects
    FOR DELETE TO authenticated USING (bucket_id = 'knowledge');
