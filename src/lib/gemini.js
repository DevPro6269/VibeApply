// src/lib/gemini.js
// Shared Gemini API client used by both the popup and the content script.
// Loaded as a regular <script> (non-module). Exposes a single global: VIBEAPPLY_GEMINI.

const VIBEAPPLY_GEMINI = (() => {
  const MODEL = "gemini-2.0-flash";
  const endpoint = (key) =>
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;

  // ---------- low-level: JSON-only Gemini call ----------
  async function geminiJsonCall({ apiKey, systemInstruction, userPrompt }) {
    const response = await fetch(endpoint(apiKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [{ text: userPrompt }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 400) throw new Error("Invalid request or API key (400)");
      if (response.status === 403) throw new Error("API key forbidden — enable Gemini for this key (403)");
      if (response.status === 429) throw new Error("Rate limit exceeded — wait a minute (429)");
      throw new Error(`Gemini error ${response.status}: ${body.slice(0, 200)}`);
    }

    const json = await response.json();
    const content = json.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!content) throw new Error("Gemini returned no content");

    try {
      return JSON.parse(content);
    } catch (e) {
      throw new Error("Gemini returned invalid JSON: " + content.slice(0, 200));
    }
  }

  // ---------- prompt: resume PDF text → structured JSON ----------
  const RESUME_SYSTEM = `You are a precise resume parser. You will be given raw text extracted from a resume PDF, sometimes followed by a list of hyperlinks found in the PDF. Your job is to convert it to STRICT JSON that matches the schema described in the user message.

Rules:
- Return JSON only. No prose, no markdown, no commentary.
- Use null for any field you cannot confidently determine.
- Do NOT invent information. If something is missing, use null.
- Dates: normalize to "YYYY-MM" when month is known, "YYYY" when only year is known, or "present" for current roles.
- Phone: keep the original formatting if reasonable.
- skills: a flat array of distinct technical skills/tools/languages (no soft skills).
- description fields: 1-3 sentences, summarizing key responsibilities & impact.

Links handling:
- The visible text may show "LinkedIn", "GitHub", "Portfolio" as labels — these are NOT URLs.
- Use the hyperlinks list at the bottom (if provided) to figure out the real URL for each label.
- Match: github.com URLs → links.github; linkedin.com → links.linkedin; personal sites → links.portfolio; anything else → links.other[].
- If no matching URL exists for a label, set that link to null.`;

  function buildResumePrompt(resumeText) {
    return `Extract this resume into JSON matching exactly this schema:

{
  "name": string,
  "email": string | null,
  "phone": string | null,
  "location": string | null,
  "links": {
    "linkedin": string | null,
    "github": string | null,
    "portfolio": string | null,
    "other": string[]
  },
  "summary": string | null,
  "skills": string[],
  "work_experience": [
    {
      "company": string,
      "title": string,
      "location": string | null,
      "start_date": string,
      "end_date": string,
      "description": string | null
    }
  ],
  "education": [
    {
      "institution": string,
      "degree": string | null,
      "field": string | null,
      "start_date": string | null,
      "end_date": string | null,
      "gpa": string | null
    }
  ],
  "certifications": [
    {
      "name": string,
      "issuer": string | null,
      "date": string | null
    }
  ],
  "projects": [
    {
      "name": string,
      "description": string | null,
      "tech": string[],
      "url": string | null
    }
  ]
}

Resume text:
---
${resumeText}
---`;
  }

  async function parseResumeWithAI(resumeText, apiKey) {
    return await geminiJsonCall({
      apiKey,
      systemInstruction: RESUME_SYSTEM,
      userPrompt: buildResumePrompt(resumeText),
    });
  }

  // ---------- prompt: detected form fields + resume + profile → { fieldId: value } ----------
  const MAPPER_SYSTEM = `You are a form-filling assistant for job applications. You will receive (1) a list of form fields on the current page, (2) the candidate's structured resume, and (3) a "profile" object with additional candidate info that the resume doesn't cover (work authorization, notice period, expected salary, etc.). You must produce a JSON mapping of field IDs to the best value.

Rules:
- Return JSON only. No prose, no markdown.
- Output shape: { "<fieldId>": <value>, ... } — one entry per input field.
- When a field has a "context" property, that's the question/heading near the field. Use it together with the label to figure out what the field is for. For example: label="Please Select One", context="What is your gender?" → use profile.gender.
- For text/textarea fields: return a plain string suitable for that input. Use the resume/profile value verbatim when possible.
- For dropdown fields: if "options" are provided, you MUST pick one of those exact option strings. Otherwise return the best match as a string.
- For date fields: return "YYYY-MM-DD". If only month is known, use day "01".
- For checkbox/radio fields: return either an exact option string from the field's options, or a boolean.
- For file fields: if the label clearly refers to a resume/CV upload (labels like "Resume", "CV", "Curriculum Vitae", "Upload Resume", "Upload CV"), return the exact string "resume". For cover letters, transcripts, portfolios, or any other document type, return null.
- If no good match exists in resume OR profile, return null. NEVER invent factual data: addresses, dates of birth, identity numbers, OR work experience dates. If resume.work_experience[N].start_date is missing/null, the corresponding "From" field must be null — do not guess.
- For open-ended questions (e.g. "Why are you a fit?", "Tell us about yourself", "Why do you want to work here?"), generate a concise 2-3 sentence answer grounded in the resume's summary, skills, and recent experience. Be professional, no clichés, no hallucinated company details.
- Skip fields whose label suggests pagination (e.g. "Search", "Continue", "Next") — return null.
- For sensitive demographic questions (gender, race, ethnicity, veteran status, disability status):
  - If the profile has the relevant value (profile.gender / profile.veteranStatus / profile.disabilityStatus), use it. Match it semantically to one of the dropdown options.
  - If profile does NOT have the value, pick the privacy-respecting option from the dropdown ("Decline to state", "Decline to answer", "Prefer not to answer", "I don't wish to answer", etc.).
  - For race/ethnicity specifically — without profile data, pick "Decline to state" / "I don't wish to answer".
  - NEVER invent demographic facts (don't guess race, sexual orientation, etc.).

Resume field mapping:
- "Given Name" / "Legal First Name" / "First Name" → resume.name (first token)
- "Family Name" / "Surname" / "Last Name" → resume.name (last token)
- "Preferred Name" → resume.name (first token)
- "Email" / "Email Address" → resume.email
- "Phone" / "Mobile" / "Phone Number" → resume.phone
- "Country" / "Country/Region" → infer from resume.location
- "City" / "State" / "Zip" → parse from resume.location
- "LinkedIn" / "LinkedIn URL" → resume.links.linkedin
- "GitHub" / "Personal Website" / "Portfolio" → resume.links.github / portfolio

Profile field mapping (use these when the resume doesn't have the data):
- "Authorized to work" / "Eligible to work" / "Work authorization status" → profile.workAuthorization
- "Visa sponsorship" / "Will you require sponsorship" / "Need sponsorship" → profile.sponsorshipNeeded
- "Notice period" / "How much notice" → profile.noticePeriod
- "Expected salary" / "Salary expectation" / "Compensation expectation" / "Desired salary" → profile.expectedSalary
- "Available start date" / "When can you start" / "Earliest start date" → profile.startDate
- "How did you hear about us" / "How did you find this opportunity" / "Source" → profile.howDidYouHear
- "Willing to relocate" / "Open to relocation" → profile.willingToRelocate
- "Gender" / "What is your gender" / "Sex" → profile.gender (match to dropdown option)
- "Veteran" / "Protected veteran status" → profile.veteranStatus
- "Disability" / "Self-identify a disability" → profile.disabilityStatus
- "Race" / "Ethnicity" / "Hispanic or Latino" → no profile field — pick "Decline to state" option if available, else null

Profile-to-options mapping (when a dropdown's options are specific Workday wording):
- If profile.workAuthorization is "Authorized to work without sponsorship" and options include something like "Yes, I am authorized to work in this country without sponsorship" — pick that one.
- If profile.sponsorshipNeeded is "No" and options include "No, I do not require sponsorship" — pick that one.
- Always pick the option that best semantically matches the profile value.

Repeatable sections (multiple experiences, educations, projects):
- Each field has an "occurrenceIndex" (defaults to 0 if not shown). When the same label appears multiple times on a page, each occurrence has a successive index: 0, 1, 2…
- occurrenceIndex = N means this field belongs to the (N+1)-th item of its kind.
- Map them like this:
  - "Company" / "Job Title" / "From" / "To" with occurrenceIndex N → resume.work_experience[N]
  - "Institution" / "Degree" / "Field of Study" with occurrenceIndex N → resume.education[N]
  - "Project Name" / "Project Description" with occurrenceIndex N → resume.projects[N]
- If the resume has fewer items than the form expects (e.g. form has 3 experience blocks but resume only has 2), return null for all fields in the missing block.

Multi-value inputs (Skills, Tags, Languages):
- For fields whose label is "Skills", "Type to Add Skills", "Languages", "Tags", or similar multi-value inputs, return a JSON ARRAY of strings (not a single string).
- Each array item will be typed into the search box. If a checkbox dropdown appears, the matching option will be clicked. If it's a chip input, Enter will be pressed.
- Pull values from resume.skills (already an array). Cap at ~10 most role-relevant skills if there are more.
- Use COMMONLY-INDEXED skill names that public taxonomies recognize: prefer "JavaScript" over "JS / ES6+", "Node.js" over "NodeJS", "PostgreSQL" over "Postgres", "Amazon Web Services" or "AWS" over "AWS (EC2)", "Docker" over "Docker containerization". Strip parenthetical detail.
- Skip composite phrases like "Schema Design" or "Middleware Design" — these rarely match Workday's catalog. Prefer concrete tool/language names.
- Example: { "f4": ["JavaScript", "Node.js", "Express.js", "MongoDB", "PostgreSQL", "Docker", "AWS", "Git", "REST API"] }

URL field handling:
- For fields with "URL", "Link", "Website", "LinkedIn", "GitHub", "Portfolio" in the label, the value MUST be a full URL starting with "https://".
- If the resume's links value isn't a valid URL (e.g., it's just "LinkedIn" or "GitHub" — a label not a URL) return null. Do NOT type a label into a URL field.
- If you have a domain without protocol (e.g., "linkedin.com/in/user"), prepend "https://".
- LinkedIn URLs should typically be in the form "https://www.linkedin.com/in/..." or "https://linkedin.com/in/..."
- GitHub URLs typically "https://github.com/..."

Date format handling:
- Each date field may include a "placeholder" hint (e.g. "MM/YYYY", "MM/DD/YYYY", "Month Year"). MATCH THAT FORMAT EXACTLY.
- "From" / "To" date fields in work experience usually want "MM/YYYY" (month + year only).
- Education "From" / "To (Actual or Expected)" fields are often YEAR ONLY (4-digit year, e.g. "2023"). If the placeholder is "YYYY" or the label says "Year", return only the year.
- Specific start/end dates may want "MM/DD/YYYY".
- If no placeholder is provided, use "YYYY-MM-DD" (our filler will reformat for HTML5 date inputs).
- For current/ongoing jobs: if resume.end_date is "present" and the field is text, return "Present".
- NEVER leave required date fields as null when the resume has the data — convert format if needed.

ABSOLUTE RULES for work-experience date fields (From / To / Start Date / End Date):
- The ONLY valid source for these is resume.work_experience[occurrenceIndex].start_date and .end_date for that exact occurrenceIndex.
- If start_date is null, missing, "", or unparseable in the resume → return null for the "From" field. Period.
- If end_date is null/missing → return null for the "To" field. Period.
- If "From" is null, the corresponding "To" must also be null.
- A "To" value MUST be chronologically >= the "From" value. If they would conflict, return null for both.
- NEVER use placeholder dates, today's date, defaults, or guesses. NEVER extrapolate from job description text.
- It is FAR better to leave 10 date fields null than to invent one wrong date.
- If there is NO resume.work_experience[N] entry for a given occurrenceIndex, all fields for that block must be null.

CRITICAL: present / ongoing jobs:
- If resume.work_experience[N].end_date is "present", "Present", "current", "now", "ongoing", or similar → the "To" field MUST get the string "Present" (capitalized). Do NOT convert it to a date. Do NOT use another job's start_date.
- If the form has a checkbox like "I currently work here" or "Currently working" for that occurrenceIndex AND end_date is "present", return true for that checkbox AND return null (or "Present") for the "To" date field.

CRITICAL: occurrenceIndex mapping:
- occurrenceIndex N refers to resume.work_experience[N] EXACTLY. Index 0 = first job in resume (usually most recent). Index 1 = second job. Etc.
- Never swap dates between jobs. Never use job 0's start with job 1's end.
- "From" + "To" + "Company" + "Title" with the same occurrenceIndex N all describe the SAME job — resume.work_experience[N].`;

  function buildMapperPrompt(fields, resume, profile) {
    const descriptors = fields.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.type,
      required: f.required || false,
      ...(f.context ? { context: f.context } : {}),
      ...(f.occurrenceIndex > 0 ? { occurrenceIndex: f.occurrenceIndex } : {}),
      ...(f.placeholder ? { placeholder: f.placeholder } : {}),
      ...(f.options?.length ? { options: f.options } : {}),
      ...(f.currentValue ? { currentValue: f.currentValue } : {}),
    }));

    return `Resume (structured JSON):
${JSON.stringify(resume, null, 2)}

Profile (additional candidate info that the resume doesn't cover):
${JSON.stringify(profile || {}, null, 2)}

Form fields on the current page (${fields.length} total):
${JSON.stringify(descriptors, null, 2)}

Return a JSON object mapping each field id to its best value. Example shape:
{
  "f0": "Pallavi",
  "f1": "Patel",
  "f2": "pallavipatel8080@gmail.com",
  "f3": null
}`;
  }

  async function mapFieldsWithAI(fields, resume, profile, apiKey) {
    return await geminiJsonCall({
      apiKey,
      systemInstruction: MAPPER_SYSTEM,
      userPrompt: buildMapperPrompt(fields, resume, profile),
    });
  }

  // Per-field fallback: given a value and a list of dropdown option texts,
  // ask Gemini to pick the best matching option. Used when local matching
  // (exact / contains / abbreviation) fails.
  async function pickOptionWithAI(value, options, context, apiKey) {
    if (!options || options.length === 0) return null;

    const systemInstruction = `You map a candidate's value to the best option in a dropdown. Return JSON only.

Rules:
- Output shape: { "choice": <exact option string from the provided list> | null }
- The "choice" MUST be one of the option strings VERBATIM (same casing, same wording, same punctuation).
- If no option is a reasonable semantic match, return { "choice": null }. Never invent.
- Examples of good matching:
  - value "Bachelor of Technology" with options ["BTECH","MCA","MBA"] → choice "BTECH"
  - value "United States" with options ["US","UK","Canada"] → choice "US"
  - value "JavaScript / Node.js" with options ["JavaScript","Python","Go"] → choice "JavaScript"
  - value "Need sponsorship" with options ["Yes","No","Maybe"] → choice "Yes"`;

    const userPrompt = `Field context: ${context || "dropdown"}

Value the candidate gave: "${value}"

Available options:
${options.map((o) => `- "${o}"`).join("\n")}

Pick the best matching option. Return JSON: { "choice": "..." } or { "choice": null }.`;

    try {
      const result = await geminiJsonCall({ apiKey, systemInstruction, userPrompt });
      return result?.choice || null;
    } catch (err) {
      console.warn("[VibeApply] pickOptionWithAI failed:", err);
      return null;
    }
  }

  return {
    MODEL,
    geminiJsonCall,
    parseResumeWithAI,
    mapFieldsWithAI,
    pickOptionWithAI,
  };
})();
