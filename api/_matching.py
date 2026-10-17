"""Motor de correspondência entre anúncios de animais perdidos e encontrados.

Fase atual (sem custo de API): pontua pares por atributos (cores, porte, sexo),
distância geográfica e intervalo de datas.

Fase futura (o toque inovador): similaridade de imagem. Implemente a interface
`ImageSimilarity` (por exemplo, embeddings CLIP salvos em pgvector, ou uma API de
visão) e registre-a em `IMAGE_MATCHERS`. Quando ela retorna um valor, o peso da
imagem entra no cálculo e os demais pesos são renormalizados automaticamente;
quando retorna None, nada muda.
"""

from __future__ import annotations

import math
import os
from datetime import date
from typing import Callable, Dict, Iterable, List, Optional, Protocol

SIZE_ORDER = {"small": 0, "medium": 1, "large": 2}

WEIGHTS: Dict[str, float] = {
    "colors": 0.30,
    "distance": 0.30,
    "size": 0.15,
    "time": 0.15,
    "sex": 0.10,
}
IMAGE_WEIGHT = 0.35

DISTANCE_SCALE_KM = 3.0   # a 3 km a nota de distância cai para ~37%
TIME_SCALE_DAYS = 21.0    # a 21 dias a nota de tempo cai para ~37%
EARLY_TOLERANCE_DAYS = 2  # "encontrado" pode ter sido registrado até 2 dias antes do "perdido"
MIN_SCORE = 0.35
DEFAULT_LIMIT = 10


class ImageSimilarity(Protocol):
    def compare(self, a: dict, b: dict) -> Optional[float]:
        """Retorna similaridade entre 0 e 1, ou None quando não há como comparar."""


class NoImageSimilarity:
    def compare(self, a: dict, b: dict) -> Optional[float]:
        return None


# Registre aqui os provedores futuros, ex.: {"clip": ClipPgvectorSimilarity}
IMAGE_MATCHERS: Dict[str, Callable[[], ImageSimilarity]] = {}


def image_matcher_from_env() -> ImageSimilarity:
    factory = IMAGE_MATCHERS.get(os.environ.get("PETSOS_IMAGE_MATCHER", "").strip())
    return factory() if factory else NoImageSimilarity()


def haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lng2 - lng1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def _to_date(value) -> date:
    return value if isinstance(value, date) else date.fromisoformat(str(value)[:10])


def _fmt_km(km: float) -> str:
    if km < 1:
        return f"{round(km * 1000 / 50) * 50:.0f} m"
    return f"{km:.1f} km".replace(".", ",")


def _lost_found(a: dict, b: dict):
    return (a, b) if a["kind"] == "lost" else (b, a)


def is_candidate(report: dict, other: dict) -> bool:
    """Regras eliminatórias: só compara o que pode ser o mesmo animal."""
    if other.get("id") == report.get("id"):
        return False
    if other.get("status", "open") != "open":
        return False
    if other.get("review_status", "approved") != "approved":
        return False
    if other["kind"] == report["kind"] or other["species"] != report["species"]:
        return False
    sexes = {report.get("sex") or "unknown", other.get("sex") or "unknown"}
    if sexes == {"male", "female"}:
        return False
    lost, found = _lost_found(report, other)
    if (_to_date(found["event_date"]) - _to_date(lost["event_date"])).days < -EARLY_TOLERANCE_DAYS:
        return False
    return True


def score_pair(report: dict, other: dict, image: ImageSimilarity = NoImageSimilarity()) -> dict:
    parts: Dict[str, float] = {}
    reasons: List[str] = []

    # Cores (índice de Jaccard)
    ca, cb = set(report.get("colors") or []), set(other.get("colors") or [])
    shared = ca & cb
    parts["colors"] = len(shared) / len(ca | cb) if ca | cb else 0.0
    if shared:
        reasons.append("Cores em comum: " + ", ".join(sorted(shared)))

    # Distância
    km = haversine_km(report["lat"], report["lng"], other["lat"], other["lng"])
    parts["distance"] = math.exp(-km / DISTANCE_SCALE_KM)
    reasons.append(f"A {_fmt_km(km)} de distância")

    # Porte
    sa, sb = report.get("size"), other.get("size")
    if sa in SIZE_ORDER and sb in SIZE_ORDER:
        gap = abs(SIZE_ORDER[sa] - SIZE_ORDER[sb])
        parts["size"] = {0: 1.0, 1: 0.4}.get(gap, 0.0)
        if gap == 0:
            reasons.append("Mesmo porte")
    else:
        parts["size"] = 0.5

    # Sexo
    xa, xb = report.get("sex") or "unknown", other.get("sex") or "unknown"
    if "unknown" in (xa, xb):
        parts["sex"] = 0.5
    else:
        parts["sex"] = 1.0
        reasons.append("Mesmo sexo")

    # Tempo entre sumiço e encontro
    lost, found = _lost_found(report, other)
    days = (_to_date(found["event_date"]) - _to_date(lost["event_date"])).days
    parts["time"] = math.exp(-max(days, 0) / TIME_SCALE_DAYS)
    if days <= 0:
        reasons.append("Encontrado no mesmo período do sumiço")
    else:
        reasons.append(f"Encontrado {days} dia{'s' if days > 1 else ''} depois do sumiço")

    weights = dict(WEIGHTS)
    similarity = image.compare(report, other)
    if similarity is not None:
        parts["image"] = max(0.0, min(1.0, similarity))
        weights["image"] = IMAGE_WEIGHT
        reasons.insert(0, f"Fotos {round(parts['image'] * 100)}% parecidas")

    total = sum(weights[k] * v for k, v in parts.items()) / sum(weights[k] for k in parts)
    return {
        "score": round(total, 3),
        "distance_km": round(km, 2),
        "breakdown": {k: round(v, 2) for k, v in parts.items()},
        "reasons": reasons,
    }


def rank(
    report: dict,
    candidates: Iterable[dict],
    image: ImageSimilarity = NoImageSimilarity(),
    limit: int = DEFAULT_LIMIT,
    min_score: float = MIN_SCORE,
) -> List[dict]:
    results = []
    for other in candidates:
        if not is_candidate(report, other):
            continue
        result = score_pair(report, other, image)
        if result["score"] >= min_score:
            results.append({"report": other, **result})
    results.sort(key=lambda r: r["score"], reverse=True)
    return results[:limit]
