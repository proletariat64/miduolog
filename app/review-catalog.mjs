// Compatibility adapter for callers using the original review module directly.
// Composed production code supplies IntakeService as this public catalog.
export class LegacyReviewCatalog {
  constructor(db) { this.db = db; }
  reviewQuestions() { return this.db.prepare("SELECT q.*,p.originalName FROM questions q JOIN imports p ON p.id=q.importId WHERE q.state='library'").all().map(q => ({...q, content: JSON.parse(q.content)})); }
  reviewQuestion(id) { return this.reviewQuestions().find(q => q.id === id) || null; }
}
