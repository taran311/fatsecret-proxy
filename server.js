app.post("/macro-targets", async (req, res) => {
  try {
    const { age, gender, height_cm, weight_kg, exercise_level } = req.body || {};

    const ageNum = Number(age);
    const heightCm = Number(height_cm);
    const weightKg = Number(weight_kg);

    if (!Number.isFinite(ageNum) || ageNum < 13 || ageNum > 90) {
      return res.status(400).json({ error: "age must be a number between 13 and 90" });
    }
    if (!Number.isFinite(heightCm) || heightCm < 120 || heightCm > 230) {
      return res.status(400).json({ error: "height_cm must be a number between 120 and 230" });
    }
    if (!Number.isFinite(weightKg) || weightKg < 35 || weightKg > 250) {
      return res.status(400).json({ error: "weight_kg must be a number between 35 and 250" });
    }
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    }

    // --- Step 1: compute deterministic baseline in code ---
    const bmr = Math.round(bmrMifflin({ gender, weightKg, heightCm, age: ageNum }));
    const tdee = Math.round(bmr * activityFactor(exercise_level));

    const maintainCalories = tdee;
    const loseCalories = Math.max(1200, tdee - 500);
    const gainCalories = tdee + 300;

    const baseline = {
      inputs: {
        age: ageNum,
        gender,
        height_cm: heightCm,
        weight_kg: weightKg,
        exercise_level,
      },
      bmr,
      tdee,
      targets: {
        lose: buildMacros({ calories: loseCalories, weightKg, protein_g_per_kg: 2.0, fat_pct: 0.25 }),
        maintain: buildMacros({ calories: maintainCalories, weightKg, protein_g_per_kg: 1.8, fat_pct: 0.27 }),
        gain: buildMacros({ calories: gainCalories, weightKg, protein_g_per_kg: 1.8, fat_pct: 0.22 }),
      },
    };

    // --- Step 2: Verify/Sanity-check with GPT (bounded adjustments) ---
    const aiResponse = await openai.responses.create({
      model: "gpt-4.1-mini",
      temperature: 0,
      text: { format: { type: "json_object" } },
      input: [
        {
          role: "system",
          content:
            "You are a nutrition coach and calculator auditor. Your job is to VERIFY the provided calorie and macro targets. " +
            "Do not invent new formulas. Only make small adjustments if the baseline is clearly unreasonable. " +
            "Hard rules: protein must be between 1.2 and 2.4 g/kg; fat must be between 0.6 and 1.2 g/kg OR 20–35% of calories; carbs are the remainder. " +
            "For weight loss, deficit should usually be 10–25% below TDEE; for gain, surplus 5–15% above TDEE. " +
            "Return JSON only.",
        },
        {
          role: "user",
          content: `Inputs:
${JSON.stringify(baseline.inputs)}

Baseline calculation (from code):
${JSON.stringify(baseline, null, 2)}

Return JSON in this exact shape:
{
  "verified": boolean,
  "confidence": number,
  "issues": string[],
  "final": {
    "bmr": number,
    "tdee": number,
    "targets": {
      "lose": { "calories": number, "protein_g": number, "carbs_g": number, "fat_g": number },
      "maintain": { "calories": number, "protein_g": number, "carbs_g": number, "fat_g": number },
      "gain": { "calories": number, "protein_g": number, "carbs_g": number, "fat_g": number }
    }
  },
  "explanation": string
}`,
        },
      ],
    });

    const verified = JSON.parse(aiResponse.output_text);

    // We return both baseline + AI-verified final so you can display "Verified by AI"
    return res.json({
      mode: "verified_by_ai",
      baseline,
      ai: verified,
    });
  } catch (err) {
    console.error("Macro targets error:", err?.response?.data || err.message || err);
    return res.status(500).json({ error: "Failed to calculate macro targets" });
  }
});
