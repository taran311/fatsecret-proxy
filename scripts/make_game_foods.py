"""Makes the extra Guess the Calories foods from the UK food tables.

Reads data/cofid.json (McCance and Widdowson's Composition of Foods
Integrated Dataset, made by import_cofid.py) and writes
lib/services/game_foods_tables.dart in the app: every plant-based food in
the tables with an everyday portion, and its calories for that portion.

Only plant foods: the app's own content never features animal products.
Groups that are plant foods by nature (fruit, vegetables, pulses, nuts,
grains, drinks) are taken, minus any entry whose name mentions an animal
ingredient; dishes only when the tables say how they were made with a
plant oil, or they're plant-based by definition.

    python scripts/make_game_foods.py ../thecaloriecard/lib/services/game_foods_tables.dart

Contains public sector information licensed under the Open Government
Licence v3.0.
"""

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent

# Anything mentioning these isn't plant-based (or might not be).
ANIMAL = re.compile(
    r"\b(milk|cheese|cheesy|egg|eggs|butter|ghee|cream|creamed|yog(h)?urt|honey|lard|"
    r"dripping|suet|beef|pork|chicken|ham|bacon|meat|fish|prawn|tuna|anchov\w*|"
    r"gelatin\w*|whey|mayonnaise|salad cream|custard|curd|mincemeat|toffee|fudge|"
    r"caramel|condensed|nog|quorn|mycoprotein|raita|hollandaise|tartare|carbonara|"
    r"worcestershire|pesto|horseradish|sausages?|croissants?|naan|paratha|puri|"
    r"bannocks?|scratchings|marzipan|chocolate|cod|lamb|turkey|liver|kofta|dudhi|"
    r"pastichio|moussaka|lasagne|cannelloni|flan|pie|pasty|roulade|crumble|"
    r"pancakes?|coo-coo|fritters?|duchesse|khadhi|icing|trail mix|betel|"
    r"build|complan|horlicks|ovaltine|smoothies?|irish|shake|buns?|spread|rissoles|"
    r"cutlets|croquettes|beanburger|cakes?)\b",
    re.IGNORECASE,
)
# "Peanut butter", "nut butter", "cocoa butter" and plant milks are fine.
PLANT_OK = re.compile(
    r"(peanut butter|nut butter|cocoa butter|butter beans?|beans, butter|"
    r"coconut milk|soya milk|milk, soya|oat milk|almond milk|rice milk|"
    r"coconut cream|cream crackers)",
    re.IGNORECASE,
)

# Dishes that are plant-based by what they are.
PLANT_DISHES = re.compile(
    r"^(ratatouille|tabouleh|sauerkraut|falafel|rice and (black-eye beans|pigeon peas|red kidney beans|split peas)|"
    r"salad, (green|tomato and onion|beetroot and onion in french dressing)|sushi, vegetable|"
    r"vine leaves, stuffed with rice|tempeh burgers|tofu burger|okra with tomatoes and onion|"
    r"chilli, (bean and lentil|vegetable)|vegetables, mixed, cooked with onion, spice and tomatoes|"
    r"pilau, vegetable|pilaf, rice with tomato|vegetable stir fry mix|vegetables, stir-fried)",
    re.IGNORECASE,
)
PLANT_OIL = re.compile(r"(vegetable|rapeseed|sunflower|corn|blended) oil", re.IGNORECASE)

# Sauces and pickles that are plant-based (the rest may have cream, cheese,
# fish or egg).
SAUCES = re.compile(
    r"^(barbecue sauce|brown fruity sauce|brown sauce|chilli sauce|chutney|curry paste|"
    r"dressing, (french|oil and lemon)|guacamole|mint sauce|piccalilli|pickle, sweet|relish|"
    r"sauce, chinese|sauce, pasta, tomato based|sauce, sweet and sour|sauce, tomato based|"
    r"sauce, traditional cook in, tomato based|soy sauce|tomato ketchup|tomato sauce)",
    re.IGNORECASE,
)

# Names that aren't foods anyone eats as they are.
NOT_EATEN = re.compile(
    r"(\bflour\b|\bundiluted\b|\bconcentrate\b|\bpowder\b|\bessence\b|"
    r"cornmeal|arrowroot|semolina, raw|sago, raw|tapioca, raw|wheatgerm|bran, wheat|"
    r"glucose liquid|dried, raw|whole, dried, raw|split, dried, raw|"
    r"\boil, (cod liver|evening primrose|wheatgerm|cottonseed|palm)\b|"
    r"potato powder|pot savouries|corn snacks|popcorn, candied|pasta and sauce mixes|"
    r"pasta shapes, coloured|rice, savoury|rice, white, pudding|lemon juice|lime juice, fresh|"
    r"vegetables?, dried|weighed as whole fruit|weighed whole|ice cream|apple juice concentrate|"
    r"\bagar\b|cole leaves|jew's ear|garlic and herb|made with fat|canned, in tomato sauce|"
    r"^coconut milk$|"
    # May well have butter, ghee, shrimp or oyster sauce in them.
    r"pilau|pilaf|curry paste|chinese stir fry|stir-fried, takeaway)",
    re.IGNORECASE,
)

POTATO_RAW = re.compile(r"^potatoes, .*raw", re.IGNORECASE)


def portion(f):
    """(label, grams or ml) for one everyday portion, or None to leave out."""
    name = f["name"].lower()
    g = f.get("group", "")
    if g.startswith("BC"):
        return ("A glass (200ml)", 200)
    if g.startswith("BN"):
        return ("1 pot (125g)", 125)
    cooked = re.search(r"boiled|cooked|steamed|baked|roasted|fried|microwaved|stewed|grilled|canned|re-heated", name)
    if g.startswith("Q"):
        if re.search(r"beer|bitter|lager|stout|guinness|cider|shandy", name):
            return ("1 pint (568ml)", 568)
        if re.search(r"wine", name):
            return ("1 medium glass (175ml)", 175)
        if re.search(r"port|sherry|vermouth", name):
            return ("1 small glass (50ml)", 50)
        if "pre-mixed" in name:
            return ("1 can (250ml)", 250)
        if re.search(r"liqueur|spirit", name):
            return ("1 single (25ml)", 25)
        return None
    if g.startswith("PA"):  # tea and coffee
        return ("A mug (250ml)", 250)
    if g.startswith("PC"):
        if re.search(r"cola|lemonade|energy|lucozade|tonic|carbonated", name):
            return ("1 can (330ml)", 330)
        return ("A glass (250ml)", 250)
    if g.startswith("PE") or g.startswith("FC"):
        return ("A glass (200ml)", 200)
    if g.startswith("OC"):
        return ("1 tablespoon (14g)", 14)
    if g.startswith("SC"):
        if name.startswith("sugar"):
            return ("1 teaspoon (4g)", 4)
        return ("1 tablespoon (15g)", 15)
    if g.startswith("SN"):
        return ("A 30g bag", 30)
    if g.startswith("WC") or g.startswith("WE"):
        if re.search(r"^(guacamole|sauce, )", name):
            return ("A portion (100g)", 100)
        return ("1 tablespoon (15g)", 15)
    if g.startswith("AI"):
        if "porridge" in name:
            return ("A bowl (200g)", 200)
        return ("30g, dry", 30)
    if g.startswith("AF") or g.startswith("AG"):
        if "roll" in name:
            return ("1 roll (60g)", 60)
        if "pitta" in name:
            return ("1 pitta (60g)", 60)
        if "chapati" in name or "tortilla" in name:
            return ("1 (55g)", 55)
        if "papadum" in name:
            return ("1 (13g)", 13)
        if "ciabatta" in name or "french stick" in name:
            return ("A 60g piece", 60)
        return ("1 slice (36g)", 36)
    if g.startswith("AA"):
        if "boiled" in name:
            return ("A portion (180g cooked)", 180)
        return ("75g, uncooked", 75)
    if g.startswith("AC") or g.startswith("AD"):
        # The tables say "raw" for uncooked rice and pasta.
        if re.search(r"\braw\b", name):
            return ("75g, uncooked", 75)
        return ("A portion (180g cooked)", 180)
    if g.startswith("DA"):
        if POTATO_RAW.search(name):
            return None
        if "chips" in name or "wedges" in name:
            return ("A portion (150g)", 150)
        return ("A portion (200g)", 200)
    if g.startswith("DB"):
        if "tofu" in name or "tempeh" in name:
            return ("100g", 100)
        if "houmous" in name:
            return ("2 tablespoons (30g)", 30)
        if re.search(r"beans, (green|runner|broad|cluster|balor|papri|sword)|beansprouts", name):
            return ("80g", 80)
        if "baked beans" in name:
            return ("Half a can (207g)", 207)
        return ("A portion (120g)", 120)
    if g.startswith("DR"):
        if name.startswith("sauce"):
            return ("A portion (100g)", 100)
        if re.search(r"pakora|bhajia|rissoles|cutlets|croquettes|burger|falafel", name):
            return ("100g", 100)
        if re.search(r"salad|sauerkraut|sushi|vine leaves", name):
            return ("100g", 100)
        return ("A portion (250g)", 250)
    if "olives" in name:
        return ("30g", 30)
    if "tomato puree" in name:
        return ("1 tablespoon (15g)", 15)
    if g.startswith("DF") or g.startswith("DG") or g == "D":
        if "juice" in name:
            return ("A glass (200ml)", 200)
        if "garlic" in name or "ginger" in name or "chilli" in name:
            return ("1 teaspoon (5g)", 5)
        return ("80g", 80)
    if g.startswith("FA") or g == "F":
        if re.search(r"dried|^raisins|^sultanas|^currants|^prunes|^dates|glace|^peel", name):
            return ("30g", 30)
        if re.search(r"canned|stewed", name):
            return ("A bowl (120g)", 120)
        return ("80g", 80)
    if g.startswith("GA") or g == "G":
        if "coconut milk" in name:
            return ("100ml", 100)
        if "peanut butter" in name or "tahini" in name:
            return ("1 tablespoon (16g)", 16)
        if "chestnuts" in name:
            return ("5 (50g)", 50)
        if "quinoa" in name:
            return ("75g, uncooked", 75)
        return ("30g", 30)
    return None


def bigger(f, usual):
    """A second, bigger portion where people really have one (a double, a
    big bowl, a sharing bag): guessing how the calories scale is half the
    fun."""
    name = f["name"].lower()
    g = f.get("group", "")
    label, amount = usual
    if g.startswith("Q"):
        if "wine" in name:
            return [("1 large glass (250ml)", 250)]
        if "spirit" in name or "liqueur" in name:
            return [("1 double (50ml)", 50)]
        if amount == 568:
            return [("1 bottle (330ml)", 330)]
        return []
    if g.startswith("GA") and amount == 30:
        return [("A big handful (50g)", 50)]
    if g.startswith("AI") and amount == 30:
        return [("A big bowl (60g, dry)", 60)]
    if (g.startswith("AF") or g.startswith("AG")) and label.startswith("1 slice"):
        return [("2 slices (72g)", 72)]
    if g.startswith("SN"):
        return [("A sharing bag (150g)", 150)]
    if (g.startswith("AC") or g.startswith("AD")) and amount == 180:
        return [("A big plate (300g cooked)", 300)]
    if g.startswith("DA") and ("chips" in name or "wedges" in name):
        return [("A large portion (250g)", 250)]
    if g.startswith("FA") and amount == 80 and "raw" in name:
        return [("A big bowl (200g)", 200)]
    if g.startswith("OC"):
        return [("1 teaspoon (5g)", 5)]
    return []


GROUPS = ("A", "D", "F", "G", "O", "P", "Q", "S", "W")
PLANT_DAIRY_FREE = re.compile(r"\b(soya|oat|almond|rice|coconut)\b", re.IGNORECASE)


def wanted(f):
    name = f["name"]
    g = f.get("group", "")
    # Plant milks and yoghurts sit with the dairy in the tables.
    if g.startswith(("BC", "BN")) and PLANT_DAIRY_FREE.search(name) and \
            not re.search(r"\b(cows|goats|sheep|whole|skimmed|semi|evaporated|condensed|greek)\b", name, re.I):
        return not NOT_EATEN.search(name)
    if not g or not g.startswith(GROUPS):
        return False
    if g.startswith(("AB", "AE", "AK", "AM", "AN", "AO", "AP", "AS", "AT", "OA", "OB", "OE", "OF",
                     "WA", "WY", "SE", "DI")):
        return False  # sandwiches, pizza, cakes, biscuits, pastry, spreads, soups...
    if NOT_EATEN.search(name):
        return False
    if ANIMAL.search(PLANT_OK.sub("", name)):
        return False
    if g.startswith("W") and not SAUCES.search(name):
        return False
    if g.startswith("DR") and not (PLANT_DISHES.search(name) or
                                   (PLANT_OIL.search(name) and "homemade" in name.lower()) or
                                   PLANT_OIL.search(name)):
        return False
    if g.startswith("QI") and "cream" in name.lower():
        return False
    return True


# Tidy names: "Rice, white, basmati, boiled in unsalted water" →
# "Rice (white, basmati, boiled)".
RENAME = {
    "Coconut milk, retail": "Coconut milk (tinned)",
    "Coconut milk, reduced fat, retail": "Coconut milk (tinned, reduced fat)",
}
DROP = [
    r" in (un)?salted water", r", flesh only", r", average",
    r", kernel only", r", re-heated", r", retail", r", homemade", r", ambient and chilled",
    r", unfortified", r", fortified", r", takeaway and restaurant", r", ends trimmed",
]


def display(name):
    if name in RENAME:
        return RENAME[name]
    n = name
    for d in DROP:
        n = re.sub(d, "", n, flags=re.IGNORECASE)
    n = n.replace("  ", " ").strip(" ,")
    n = re.sub(r"Kernel only", "", n).strip(" ,")
    parts = [p.strip() for p in n.split(",") if p.strip()]
    if len(parts) == 1:
        return parts[0]
    head, rest = parts[0], parts[1:]
    return f"{head} ({', '.join(rest)})"


EMOJI = [
    (r"banana|plantain", "🍌"), (r"apple", "🍎"), (r"pear\b|pears", "🍐"),
    (r"orange|mandarin|satsuma|clementine|tangerine|kumquat", "🍊"), (r"lemon|lime", "🍋"),
    (r"grape|raisin|sultana|currant", "🍇"), (r"strawberr", "🍓"), (r"cherr", "🍒"),
    (r"peach|apricot|nectarine|plum|prune|damson", "🍑"), (r"watermelon", "🍉"),
    (r"melon", "🍈"), (r"pineapple", "🍍"), (r"mango", "🥭"), (r"kiwi", "🥝"),
    (r"coconut", "🥥"), (r"blueberr|blackberr|blackcurrant|bilberr|elderberr", "🫐"),
    (r"avocado", "🥑"), (r"tomato", "🍅"), (r"potato|chips|crisps|wedges|pringle", "🥔"),
    (r"carrot", "🥕"), (r"sweetcorn|corn on|\bcorn\b|popcorn|tortilla chips", "🌽"),
    (r"pepper", "🫑"), (r"chilli", "🌶️"), (r"cucumber|courgette|gherkin|marrow", "🥒"),
    (r"broccoli|cauliflower", "🥦"), (r"mushroom", "🍄"), (r"onion|leek|shallot", "🧅"),
    (r"garlic", "🧄"), (r"aubergine", "🍆"), (r"olive", "🫒"),
    (r"lettuce|cabbage|spinach|kale|chard|cress|rocket|endive|chicory|pak choi|greens|leaves|sprout|callaloo", "🥬"),
    (r"lentil|chick pea|beans?, |bean|gram|dahl|houmous|falafel|pigeon pea", "🫘"),
    (r"\bpeas?\b|mangetout|edamame", "🫛"), (r"peanut", "🥜"),
    (r"almond|walnut|hazelnut|cashew|pistachio|brazil|pecan|chestnut|macadamia|nuts", "🌰"),
    (r"seed", "🌻"), (r"tofu|tempeh", "🧊"), (r"rice|pilau|pilaf|sushi", "🍚"),
    (r"noodle", "🍜"), (r"pasta|spaghetti|macaroni|fusilli|tagliatelle", "🍝"),
    (r"roll", "🥖"), (r"pitta|chapati|tortilla|papadum", "🫓"), (r"bread|toast|ciabatta", "🍞"),
    (r"cereal|flakes|muesli|porridge|weetabix|wheat|oat|hoops|loops", "🥣"),
    (r"beer|bitter|lager|stout|guinness|cider|shandy", "🍺"), (r"wine|port|sherry|vermouth", "🍷"),
    (r"spirit|liqueur", "🥃"), (r"\btea\b", "🍵"), (r"coffee", "☕"),
    (r"cola|lemonade|tonic|lucozade|energy|squash|cordial|barley water|drink", "🥤"),
    (r"juice", "🧃"), (r"jam|marmalade|chutney|relish|pickle|piccalilli", "🫙"),
    (r"sugar", "🍬"), (r"syrup|treacle|molasses", "🍯"), (r"\boil\b", "🫒"),
    (r"sauce|ketchup|dressing|paste|guacamole", "🥫"), (r"beetroot|radish", "🟣"),
    (r"squash|pumpkin", "🎃"), (r"fig|date", "🟤"),
]
GROUP_EMOJI = {"B": "🥛", "F": "🍎", "D": "🥬", "G": "🌰", "A": "🌾", "P": "🥤", "Q": "🍷", "S": "🥨", "O": "🫒", "W": "🥫"}


DRINK_EMOJI = {"🍺", "🍷", "🥃", "🍵", "☕", "🥤", "🧃"}


def emoji(name, group):
    """From what the food is (the first part of its name), so "Asparagus,
    steamed" isn't a cup of tea and "Peas, boiled" isn't oil."""
    head = name.split(",")[0].lower()
    drinks_ok = group[:1] in ("P", "Q") or "juice" in head
    for pat, e in EMOJI:
        if e in DRINK_EMOJI and not drinks_ok:
            continue
        if re.search(pat, head):
            return e
    return GROUP_EMOJI.get(group[:1], "🍽️")


def dart_str(s):
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'").replace("$", "\\$") + "'"


def picked_names(out_path):
    """Names of the hand-picked foods (in calorie_game.dart next to the
    output): a table food with the same name is left out, so one food
    never has two different answers."""
    picked = Path(out_path).with_name("calorie_game.dart")
    if not picked.exists():
        return set()
    text = picked.read_text(encoding="utf-8")
    return {
        m.group(1).replace("\\'", "'").lower()
        for m in re.finditer(r"GameFood\('[^']*', '((?:[^'\\]|\\.)*)'", text)
    }


def main(out_path):
    foods = json.loads((HERE / "data" / "cofid.json").read_text(encoding="utf-8"))["foods"]
    seen = set()
    taken = picked_names(out_path)
    rows = []
    for f in foods:
        if not wanted(f):
            continue
        p = portion(f)
        if not p:
            continue
        name = display(f["name"])
        if name.lower() in taken:
            continue
        for label, amount in [p, *bigger(f, p)]:
            kcal = round(f["per100"]["calories"] * amount / 100)
            if kcal < 1 or kcal > 1500:  # 0 kcal is no fun to guess (and divides badly)
                continue
            key = (name.lower(), label.lower())
            if key in seen:
                continue
            seen.add(key)
            rows.append((emoji(f["name"], f.get("group", "")), name, label, kcal, f.get("group", "")))

    rows.sort(key=lambda r: (r[4][:1], r[1].lower()))
    lines = [
        "// GENERATED by fatsecret-proxy/scripts/make_game_foods.py from the UK",
        "// food tables (McCance and Widdowson's Composition of Foods Integrated",
        "// Dataset 2021). Don't edit by hand: change the script and run it again.",
        "//",
        "// Contains public sector information licensed under the Open Government",
        "// Licence v3.0.",
        "",
        "import 'package:namer_app/services/calorie_game.dart';",
        "",
        "/// Every plant-based food in the UK food tables, with an everyday portion",
        "/// and its calories, for the games (on top of the hand-picked foods).",
        "const List<GameFood> kTableGameFoods = [",
    ]
    for e, name, label, kcal, _ in rows:
        lines.append(f"  GameFood({dart_str(e)}, {dart_str(name)}, {dart_str(label)}, {kcal}),")
    lines.append("];")
    Path(out_path).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{len(rows)} foods written to {out_path}")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
