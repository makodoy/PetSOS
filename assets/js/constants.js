export const CITY_CENTER = [-23.5917, -48.0531]; // Itapetininga, SP
export const CITY_ZOOM = 13;

export const KIND_LABEL = { lost: "Perdido", found: "Encontrado" };
export const SPECIES_LABEL = { dog: "Cão", cat: "Gato", other: "Outro animal" };
export const SIZE_LABEL = { small: "Pequeno", medium: "Médio", large: "Grande" };
export const SEX_LABEL = { male: "Macho", female: "Fêmea", unknown: "Não informado" };
export const STATUS_LABEL = { open: "Aberto", reunited: "Reencontrado", closed: "Encerrado" };

// Cores de pelagem: conteúdo do anúncio, não fazem parte da paleta da interface.
export const COLORS = [
  { id: "preto", label: "Preto", swatch: "#222222" },
  { id: "branco", label: "Branco", swatch: "#F4F4F2" },
  { id: "cinza", label: "Cinza", swatch: "#8C918E" },
  { id: "marrom", label: "Marrom", swatch: "#6B4A33" },
  { id: "caramelo", label: "Caramelo", swatch: "#C68B4E" },
  { id: "bege", label: "Bege", swatch: "#DCC9A6" },
  { id: "tigrado", label: "Tigrado", swatch: "repeating-linear-gradient(45deg,#6B4A33 0 3px,#C68B4E 3px 6px)" },
  { id: "tricolor", label: "Tricolor", swatch: "linear-gradient(90deg,#222 0 33%,#C68B4E 33% 66%,#F4F4F2 66%)" },
];
export const COLOR_LABEL = Object.fromEntries(COLORS.map((c) => [c.id, c.label]));

export const CUSTODY_LABEL = { with_finder: "Está com quem encontrou", sighted: "Só foi avistado" };
export const CONTEXT_LABEL = { inquiry: "Pergunta sobre o animal", sighted: "Viu o animal", has_pet: "Está com o animal" };
export const REVIEW_LABEL = { pending: "Aguardando aprovação", approved: "Aprovado", rejected: "Recusado" };
export const HANDOVER_LABEL = {
  under_review: "Em revisão",
  approved: "Entrega liberada",
  rejected: "Revisão recusada",
  completed: "Entrega concluída",
};
