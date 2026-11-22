#!/usr/bin/env python3
"""Construit la base SQLite hors ligne à partir des extractions kaikki.org du Wiktionnaire français.

Usage : python3 build_dict.py <dossier_jsonl> <sortie.sqlite>
Le dossier doit contenir Français.jsonl, Anglais.jsonl, Espagnol.jsonl,
Allemand.jsonl, Italien.jsonl, Russe.jsonl
(https://kaikki.org/frwiktionary/<Langue>/kaikki.org-dictionary-<Langue>.jsonl).
"""
import json
import os
import sqlite3
import sys
import unicodedata

FILES = {
    "fr": "Français.jsonl",
    "en": "Anglais.jsonl",
    "es": "Espagnol.jsonl",
    "de": "Allemand.jsonl",
    "it": "Italien.jsonl",
    "ru": "Russe.jsonl",
}
LANGS = set(FILES)
# Langues anciennes utiles pour les racines (affichées, pas cherchées).
ARTICLES = {
    "de": ("der ", "die ", "das ", "den ", "dem ", "des "),
    "it": ("il ", "lo ", "la ", "i ", "gli ", "le ", "l’", "l'"),
    "es": ("el ", "la ", "los ", "las "),
    "en": ("the ", "a ", "an ", "to "),
}
GENDER_TAGS = {"masculine", "feminine", "neuter"}
# Étiquettes grammaticales (en anglais dans l'extraction) traduites pour l'affichage.
TAG_FR = {
    "indicative": "indicatif", "subjunctive": "subjonctif", "conditional": "conditionnel",
    "imperative": "impératif", "infinitive": "infinitif", "participle": "participe",
    "gerund": "gérondif", "present": "présent", "past": "passé", "future": "futur",
    "imperfect": "imparfait", "pluperfect": "plus-que-parfait", "perfect": "parfait",
    "anterior": "antérieur", "preterite": "prétérit", "singular": "singulier", "plural": "pluriel",
    "masculine": "masculin", "feminine": "féminin", "neuter": "neutre",
    "nominative": "nominatif", "accusative": "accusatif", "genitive": "génitif", "dative": "datif",
    "instrumental": "instrumental", "prepositional": "prépositionnel", "locative": "locatif",
    "vocative": "vocatif", "first-person": "1re pers.", "second-person": "2e pers.",
    "third-person": "3e pers.", "comparative": "comparatif", "superlative": "superlatif",
    "diminutive": "diminutif", "augmentative": "augmentatif", "animate": "animé",
    "inanimate": "inanimé", "perfective": "perfectif", "imperfective": "imperfectif",
    "short-form": "forme courte", "strong": "forte", "weak": "faible", "mixed": "mixte",
    "definite": "défini", "indefinite": "indéfini", "obsolete": "vieilli", "archaic": "archaïque",
    "dated": "vieilli", "informal": "familier", "rare": "rare", "pronominal": "pronominal",
}
SKIP_TAGS = {"multiword-construction", "canonical", "table-tags", "inflection-template", "class"}


def norm(s: str) -> str:
    """Clé de recherche : minuscules, sans accent tonique russe, apostrophes unifiées."""
    s = s.replace("́", "").replace("̀", "").replace("’", "'")
    s = unicodedata.normalize("NFC", s)
    return s.lower().strip()


def strip_article(lang, form):
    for a in ARTICLES.get(lang, ()):
        if form.lower().startswith(a):
            return form[len(a):]
    return form


def first_gloss(sense):
    g = sense.get("glosses") or []
    return g[-1] if g else None


def main(src, out):
    if os.path.exists(out):
        os.remove(out)
    db = sqlite3.connect(out)
    db.executescript(
        """
        PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
        CREATE TABLE entry(
          id INTEGER PRIMARY KEY, lang TEXT, word TEXT, key TEXT, pos TEXT,
          gender TEXT, ipa TEXT, glosses TEXT, etym TEXT, multi INTEGER);
        CREATE TABLE form(lang TEXT, key TEXT, lemma TEXT, info INTEGER,
                          PRIMARY KEY(lang, key, lemma)) WITHOUT ROWID;
        CREATE TABLE info(id INTEGER PRIMARY KEY, txt TEXT);
        CREATE TABLE trans(entry_id INTEGER, lang TEXT, word TEXT);
        CREATE TABLE etym(entry_id INTEGER, target TEXT);
        """
    )
    next_id = 1
    info_ids = {}
    for lang, fname in FILES.items():
        path = os.path.join(src, fname)
        n_entries = n_forms = 0
        forms_seen = {}   # formes "form-of" (explication en français, prioritaires)
        forms_list = {}   # formes listées dans les tableaux de flexion
        with open(path, encoding="utf-8") as f:
            for line in f:
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("lang_code") != lang:
                    continue
                word = d.get("word")
                if not word:
                    continue
                pos = d.get("pos_title") or d.get("pos") or ""
                real, formof = [], []
                for s in d.get("senses", []):
                    if s.get("form_of") or "form-of" in (s.get("tags") or []):
                        formof.append(s)
                    elif first_gloss(s):
                        real.append(s)
                # Formes fléchies -> lemme, avec l'explication grammaticale.
                for s in formof:
                    g = first_gloss(s)
                    for fo in s.get("form_of") or [{"word": None}]:
                        lemma = fo.get("word")
                        if not lemma:
                            continue
                        k = (norm(word), lemma)
                        infos = forms_seen.setdefault(k, [])
                        if g and g not in infos and len(infos) < 6:
                            infos.append(g)
                if not real:
                    continue
                gender = ",".join(t for t in d.get("tags", []) if t in GENDER_TAGS)
                ipa = next((x["ipa"] for x in d.get("sounds", []) if x.get("ipa")), None)
                glosses = [first_gloss(s)[:180] for s in real[:3]]
                etym = " ".join(d.get("etymology_texts") or [])[:600] or None
                eid = next_id
                next_id += 1
                db.execute(
                    "INSERT INTO entry VALUES(?,?,?,?,?,?,?,?,?,?)",
                    (eid, lang, word, norm(word), pos, gender or None, ipa,
                     json.dumps(glosses, ensure_ascii=False), etym, int(" " in word.strip())),
                )
                n_entries += 1
                targets = {t[1] for t in d.get("etymology_links") or [] if len(t) > 1 and "#" in t[1]}
                db.executemany("INSERT INTO etym VALUES(?,?)", [(eid, norm(t)) for t in targets])
                # Formes listées dans l'entrée (pluriels, déclinaisons...).
                for fm in d.get("forms") or []:
                    form = fm.get("form")
                    if not form or form == word or len(form) > 40:
                        continue
                    form = strip_article(lang, form)
                    if " " in form.strip():
                        continue  # temps composés, etc. : inutiles pour chercher un mot seul
                    k = (norm(form), word)
                    infos = forms_list.setdefault(k, [])
                    tl = fm.get("tags") or []
                    if any(t in SKIP_TAGS for t in tl):
                        continue
                    tags = " ".join(TAG_FR.get(t, t) for t in tl)
                    if tags and tags not in infos and len(infos) < 6:
                        infos.append(tags)
                if lang == "fr":
                    seen = set()
                    for t in d.get("translations") or []:
                        tl, tw = t.get("lang_code"), t.get("word")
                        if tl in LANGS and tw and (tl, tw) not in seen:
                            seen.add((tl, tw))
                            db.execute("INSERT INTO trans VALUES(?,?,?)", (eid, tl, tw))
        for k, infos in forms_list.items():
            if k not in forms_seen:
                forms_seen[k] = infos
        rows = []
        for (k, lemma), infos in forms_seen.items():
            txt = "; ".join(i.rstrip(".") for i in infos).replace(lemma, "~") if infos else ""
            iid = info_ids.get(txt)
            if iid is None:
                iid = info_ids[txt] = len(info_ids)
            rows.append((lang, k, lemma, iid))
        db.executemany("INSERT OR IGNORE INTO form VALUES(?,?,?,?)", rows)
        n_forms = len(rows)
        db.commit()
        print(f"{lang}: {n_entries} entrées, {n_forms} formes", flush=True)
    db.executemany("INSERT INTO info VALUES(?,?)", [(i, t) for t, i in info_ids.items()])
    db.executescript(
        """
        CREATE INDEX entry_key ON entry(lang, key);
        CREATE INDEX trans_e ON trans(entry_id);
        CREATE INDEX trans_w ON trans(lang, word);
        CREATE INDEX etym_e ON etym(entry_id);
        CREATE INDEX etym_t ON etym(target);
        """
    )
    db.commit()
    db.execute("VACUUM")
    db.close()


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
