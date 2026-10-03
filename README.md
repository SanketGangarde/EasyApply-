# Job Match Helper

Chrome extension that compares your resume with the job page you have open.

## Install
1. Unzip this folder.
2. Open chrome://extensions and turn on Developer mode (top right).
3. Click "Load unpacked" and choose the unzipped job-match-helper folder.
4. Click the extension icon to open the side panel.

## First-time setup
1. Get a free API key at https://console.groq.com/keys
2. Open Settings in the panel, paste the key and click Save settings.
3. Upload your resume (PDF or text). It is saved in your browser only.

## Use
Open a job posting, click Analyze this page. For best results, select just the
job description text on the page before clicking.

## Notes
- Your resume and the page text are sent to Groq to produce the analysis.
- Groq's free tier limits tokens per minute. If you see a rate limit message, wait a minute.
- The fit score is a resume-to-posting match, not a hiring prediction.
