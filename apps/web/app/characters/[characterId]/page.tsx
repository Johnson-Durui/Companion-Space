import { CharacterEditor } from "@/components/character-editor";

export default async function CharacterDetailPage({ params }: { params: Promise<{ characterId: string }> }) {
  const { characterId } = await params;
  return <CharacterEditor characterId={characterId} />;
}
