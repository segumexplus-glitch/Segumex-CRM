-- Migration commented out to avoid "already exists" errors during repair
-- Objects were already created in a previous run.
-- Original content preserved below for reference:
/*
create table if not exists products (
  id uuid default gen_random_uuid() primary key,
  name text not null,
  description text,
  price text, -- text to allow "Desde $5,000" etc.
  requirements text, -- "Edad, Documentos, etc"
  metadata jsonb default '{}'::jsonb,
  created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table products enable row level security;

create policy "Public Read Products" on products
  for select using (true);

create policy "Authenticated Insert Products" on products
  for insert with check (auth.role() = 'authenticated');

create policy "Authenticated Update Products" on products
  for update using (auth.role() = 'authenticated');

insert into products (name, description, price, requirements) values
('Seguro de Auto Amplio', 'Cobertura completa contra daños materiales, robo total y daños a terceros. Incluye asistencia vial.', 'Desde $4,500 anual', 'Marca, Modelo, Versión y Año del auto. Código Postal.'),
('Seguro de Gastos Médicos Mayores', 'Cubre hospitalización, honorarios médicos y medicamentos en caso de accidente o enfermedad.', 'Cotización personalizada', 'Edad, Sexo, Código Postal y Ocupación.'),
('Seguro de Vida', 'Protección financiera para tus beneficiarios en caso de fallecimiento o invalidez.', 'Desde $300 mensuales', 'Edad, Sexo, Suma Asegurada deseada.');
*/
