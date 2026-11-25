CREATE INDEX "access_tokens_revoked_at_idx" ON "access_tokens" USING btree ("revoked_at");--> statement-breakpoint
CREATE INDEX "audit_log_at_idx" ON "audit_log" USING btree ("at");--> statement-breakpoint
CREATE INDEX "audit_log_user_id_idx" ON "audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "token_activity_last_seen_idx" ON "token_activity" USING btree ("last_seen");--> statement-breakpoint
CREATE INDEX "token_activity_day_idx" ON "token_activity" USING btree ("day");--> statement-breakpoint
CREATE INDEX "webhook_events_received_at_idx" ON "webhook_events" USING btree ("received_at");