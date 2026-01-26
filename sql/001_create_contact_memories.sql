-- Migration: Create contact_memories table
-- Description: Stores memory state for contacts (name confirmation, facts, etc.)
-- Run this in Supabase SQL Editor

-- Create contact_memories table
CREATE TABLE IF NOT EXISTS contact_memories (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,

  -- Name confirmation state
  name_asked BOOLEAN DEFAULT false,
  name_confirmed BOOLEAN DEFAULT false,
  name_confirmed_at TIMESTAMPTZ,
  original_whatsapp_name TEXT,

  -- Additional memory fields (for future use)
  facts JSONB DEFAULT '[]'::jsonb,
  objections JSONB DEFAULT '[]'::jsonb,
  qualification JSONB DEFAULT '{}'::jsonb,

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),

  -- Ensure one memory record per contact
  CONSTRAINT contact_memories_contact_id_unique UNIQUE (contact_id)
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_contact_memories_organization_id ON contact_memories(organization_id);
CREATE INDEX IF NOT EXISTS idx_contact_memories_contact_id ON contact_memories(contact_id);

-- Enable RLS (Row Level Security)
ALTER TABLE contact_memories ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only access memories from their organization
CREATE POLICY "Users can view their organization's contact memories"
  ON contact_memories
  FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert contact memories for their organization"
  ON contact_memories
  FOR INSERT
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update contact memories for their organization"
  ON contact_memories
  FOR UPDATE
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete contact memories for their organization"
  ON contact_memories
  FOR DELETE
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
      WHERE user_id = auth.uid()
    )
  );

-- Service role policy (for backend operations)
CREATE POLICY "Service role has full access to contact memories"
  ON contact_memories
  FOR ALL
  USING (auth.role() = 'service_role');

-- Add comment to table
COMMENT ON TABLE contact_memories IS 'Stores AI agent memory state for contacts (name confirmation, conversation facts, etc.)';
COMMENT ON COLUMN contact_memories.name_asked IS 'True if the agent already asked for the real name';
COMMENT ON COLUMN contact_memories.name_confirmed IS 'True if the contact confirmed their real name';
COMMENT ON COLUMN contact_memories.original_whatsapp_name IS 'Original name from WhatsApp profile before confirmation';
