import { lazy, Suspense, useState } from "react";
import { createAvatarSpeechController } from "@companion-space/avatar-engine/speech-controller";
import type { Character } from "../../app/api";
import "../classroom/classroom.css";

const Avatar = lazy(() => import("../classroom/classroom-avatar"));
const gaze = { active: false, x: 0, y: 0 };

export function TeacherPreview({ character }: { character: Character }) {
  const [speechController] = useState(createAvatarSpeechController);
  if (character.appearance.kind === "portrait") {
    return <img src={character.appearance.src} alt={character.name} decoding="async" />;
  }
  return <Suspense fallback={<span role="img" aria-label={character.name}>{character.name.slice(0, 1)}</span>}>
    <Avatar appearance={character.appearance} name={character.name} emotion="neutral" state="idle"
      gaze={gaze} gestureSequence={0} reactionKey={null} speechController={speechController} />
  </Suspense>;
}
