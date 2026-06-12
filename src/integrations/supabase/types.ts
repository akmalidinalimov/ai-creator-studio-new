export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      _internal_settings: {
        Row: {
          key: string
          value: string
        }
        Insert: {
          key: string
          value: string
        }
        Update: {
          key?: string
          value?: string
        }
        Relationships: []
      }
      admin_actions: {
        Row: {
          action: string
          actor_user_id: string
          created_at: string
          details: Json
          id: string
          target_resource_id: string | null
          target_resource_type: string | null
          target_user_id: string | null
        }
        Insert: {
          action: string
          actor_user_id: string
          created_at?: string
          details?: Json
          id?: string
          target_resource_id?: string | null
          target_resource_type?: string | null
          target_user_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string
          created_at?: string
          details?: Json
          id?: string
          target_resource_id?: string | null
          target_resource_type?: string | null
          target_user_id?: string | null
        }
        Relationships: []
      }
      admin_notification_log: {
        Row: {
          id: string
          notification_type: string
          payload: Json
          sent_at: string
          user_id: string
        }
        Insert: {
          id?: string
          notification_type: string
          payload?: Json
          sent_at?: string
          user_id: string
        }
        Update: {
          id?: string
          notification_type?: string
          payload?: Json
          sent_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ai_chat_errors: {
        Row: {
          created_at: string
          error_excerpt: string | null
          id: string
          lesson_id: string | null
          model: string | null
          status: number | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          error_excerpt?: string | null
          id?: string
          lesson_id?: string | null
          model?: string | null
          status?: number | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          error_excerpt?: string | null
          id?: string
          lesson_id?: string | null
          model?: string | null
          status?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      ai_chat_messages: {
        Row: {
          content: string
          created_at: string
          id: string
          lesson_id: string | null
          role: Database["public"]["Enums"]["chat_role"]
          user_id: string
        }
        Insert: {
          content: string
          created_at?: string
          id?: string
          lesson_id?: string | null
          role: Database["public"]["Enums"]["chat_role"]
          user_id: string
        }
        Update: {
          content?: string
          created_at?: string
          id?: string
          lesson_id?: string | null
          role?: Database["public"]["Enums"]["chat_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_chat_messages_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_chat_messages_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "mv_lesson_dropoff"
            referencedColumns: ["lesson_id"]
          },
        ]
      }
      ai_chat_metrics: {
        Row: {
          attempts: number
          created_at: string
          fallback_used: boolean
          id: string
          language: string | null
          latency_ms: number
          lesson_id: string | null
          model: string | null
          status: number | null
          success: boolean
          user_id: string | null
        }
        Insert: {
          attempts?: number
          created_at?: string
          fallback_used?: boolean
          id?: string
          language?: string | null
          latency_ms?: number
          lesson_id?: string | null
          model?: string | null
          status?: number | null
          success?: boolean
          user_id?: string | null
        }
        Update: {
          attempts?: number
          created_at?: string
          fallback_used?: boolean
          id?: string
          language?: string | null
          latency_ms?: number
          lesson_id?: string | null
          model?: string | null
          status?: number | null
          success?: boolean
          user_id?: string | null
        }
        Relationships: []
      }
      ai_knowledge_chunks: {
        Row: {
          chunk_index: number
          content: string
          course_id: string | null
          created_at: string
          document_id: string
          embedding: string | null
          id: string
          scope: Database["public"]["Enums"]["knowledge_scope"]
          tokens: number | null
        }
        Insert: {
          chunk_index: number
          content: string
          course_id?: string | null
          created_at?: string
          document_id: string
          embedding?: string | null
          id?: string
          scope: Database["public"]["Enums"]["knowledge_scope"]
          tokens?: number | null
        }
        Update: {
          chunk_index?: number
          content?: string
          course_id?: string | null
          created_at?: string
          document_id?: string
          embedding?: string | null
          id?: string
          scope?: Database["public"]["Enums"]["knowledge_scope"]
          tokens?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_knowledge_chunks_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "ai_knowledge_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_knowledge_documents: {
        Row: {
          chunk_count: number
          course_id: string | null
          created_at: string
          created_by: string | null
          error: string | null
          file_name: string
          file_path: string
          id: string
          mime_type: string | null
          page_count: number | null
          preview: string | null
          scope: Database["public"]["Enums"]["knowledge_scope"]
          size_bytes: number
          status: Database["public"]["Enums"]["knowledge_status"]
          updated_at: string
        }
        Insert: {
          chunk_count?: number
          course_id?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          file_name: string
          file_path: string
          id?: string
          mime_type?: string | null
          page_count?: number | null
          preview?: string | null
          scope: Database["public"]["Enums"]["knowledge_scope"]
          size_bytes?: number
          status?: Database["public"]["Enums"]["knowledge_status"]
          updated_at?: string
        }
        Update: {
          chunk_count?: number
          course_id?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          file_name?: string
          file_path?: string
          id?: string
          mime_type?: string | null
          page_count?: number | null
          preview?: string | null
          scope?: Database["public"]["Enums"]["knowledge_scope"]
          size_bytes?: number
          status?: Database["public"]["Enums"]["knowledge_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_knowledge_documents_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      app_settings: {
        Row: {
          description: string | null
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          description?: string | null
          key: string
          updated_at?: string
          updated_by?: string | null
          value: Json
        }
        Update: {
          description?: string | null
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: []
      }
      audit_log: {
        Row: {
          action: string
          actor_user_id: string
          created_at: string
          id: string
          new_value: Json
          old_value: Json
          target_user_id: string | null
        }
        Insert: {
          action: string
          actor_user_id: string
          created_at?: string
          id?: string
          new_value?: Json
          old_value?: Json
          target_user_id?: string | null
        }
        Update: {
          action?: string
          actor_user_id?: string
          created_at?: string
          id?: string
          new_value?: Json
          old_value?: Json
          target_user_id?: string | null
        }
        Relationships: []
      }
      auth_events: {
        Row: {
          created_at: string
          event: string
          id: string
          ip: string | null
          user_agent: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          event: string
          id?: string
          ip?: string | null
          user_agent?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          event?: string
          id?: string
          ip?: string | null
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      badge_award_queue: {
        Row: {
          awarded_at: string
          badge_id: string
          created_at: string
          id: string
          scheduled_for: string
          sent_at: string | null
          user_id: string
        }
        Insert: {
          awarded_at?: string
          badge_id: string
          created_at?: string
          id?: string
          scheduled_for?: string
          sent_at?: string | null
          user_id: string
        }
        Update: {
          awarded_at?: string
          badge_id?: string
          created_at?: string
          id?: string
          scheduled_for?: string
          sent_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "badge_award_queue_badge_id_fkey"
            columns: ["badge_id"]
            isOneToOne: false
            referencedRelation: "badges"
            referencedColumns: ["id"]
          },
        ]
      }
      badges: {
        Row: {
          code: string
          created_at: string
          criteria: Json
          description_en: string | null
          description_ru: string | null
          description_uz: string | null
          icon: string | null
          id: string
          name_en: string
          name_ru: string
          name_uz: string
          position: number
        }
        Insert: {
          code: string
          created_at?: string
          criteria?: Json
          description_en?: string | null
          description_ru?: string | null
          description_uz?: string | null
          icon?: string | null
          id?: string
          name_en: string
          name_ru: string
          name_uz: string
          position?: number
        }
        Update: {
          code?: string
          created_at?: string
          criteria?: Json
          description_en?: string | null
          description_ru?: string | null
          description_uz?: string | null
          icon?: string | null
          id?: string
          name_en?: string
          name_ru?: string
          name_uz?: string
          position?: number
        }
        Relationships: []
      }
      bot_broadcast_rate: {
        Row: {
          actor_user_id: string
          created_at: string
          id: string
          recipient_user_id: string | null
          scope: string
        }
        Insert: {
          actor_user_id: string
          created_at?: string
          id?: string
          recipient_user_id?: string | null
          scope: string
        }
        Update: {
          actor_user_id?: string
          created_at?: string
          id?: string
          recipient_user_id?: string | null
          scope?: string
        }
        Relationships: []
      }
      bot_conversation_state: {
        Row: {
          context: Json
          expires_at: string
          state: string
          telegram_id: number
          updated_at: string
        }
        Insert: {
          context?: Json
          expires_at?: string
          state: string
          telegram_id: number
          updated_at?: string
        }
        Update: {
          context?: Json
          expires_at?: string
          state?: string
          telegram_id?: number
          updated_at?: string
        }
        Relationships: []
      }
      bot_homework_intents: {
        Row: {
          assignment_id: string
          created_at: string
          expires_at: string
          group_id: string | null
          id: string
          module_id: string
          telegram_chat_id: number
          telegram_thread_id: number
          user_id: string
        }
        Insert: {
          assignment_id: string
          created_at?: string
          expires_at?: string
          group_id?: string | null
          id?: string
          module_id: string
          telegram_chat_id: number
          telegram_thread_id: number
          user_id: string
        }
        Update: {
          assignment_id?: string
          created_at?: string
          expires_at?: string
          group_id?: string | null
          id?: string
          module_id?: string
          telegram_chat_id?: number
          telegram_thread_id?: number
          user_id?: string
        }
        Relationships: []
      }
      bot_sessions: {
        Row: {
          data: Json
          state: string
          updated_at: string
          user_id: string
        }
        Insert: {
          data?: Json
          state: string
          updated_at?: string
          user_id: string
        }
        Update: {
          data?: Json
          state?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      courses: {
        Row: {
          ai_knowledge_paths: string[] | null
          ai_system_prompt: string | null
          cover_url: string | null
          created_at: string
          description: string | null
          duration_hours: number | null
          id: string
          is_default_for_signup: boolean
          published: boolean
          tagline: string | null
          title: string
          updated_at: string
        }
        Insert: {
          ai_knowledge_paths?: string[] | null
          ai_system_prompt?: string | null
          cover_url?: string | null
          created_at?: string
          description?: string | null
          duration_hours?: number | null
          id?: string
          is_default_for_signup?: boolean
          published?: boolean
          tagline?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          ai_knowledge_paths?: string[] | null
          ai_system_prompt?: string | null
          cover_url?: string | null
          created_at?: string
          description?: string | null
          duration_hours?: number | null
          id?: string
          is_default_for_signup?: boolean
          published?: boolean
          tagline?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      daily_watch_summary: {
        Row: {
          total_seconds: number
          updated_at: string
          user_id: string
          watch_date: string
        }
        Insert: {
          total_seconds?: number
          updated_at?: string
          user_id: string
          watch_date: string
        }
        Update: {
          total_seconds?: number
          updated_at?: string
          user_id?: string
          watch_date?: string
        }
        Relationships: []
      }
      email_events: {
        Row: {
          id: string
          opened_at: string | null
          sent_at: string
          type: string
          user_id: string | null
        }
        Insert: {
          id?: string
          opened_at?: string | null
          sent_at?: string
          type: string
          user_id?: string | null
        }
        Update: {
          id?: string
          opened_at?: string | null
          sent_at?: string
          type?: string
          user_id?: string | null
        }
        Relationships: []
      }
      enrollments: {
        Row: {
          course_id: string
          enrolled_at: string
          id: string
          user_id: string
        }
        Insert: {
          course_id: string
          enrolled_at?: string
          id?: string
          user_id: string
        }
        Update: {
          course_id?: string
          enrolled_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "enrollments_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      group_message_events: {
        Row: {
          created_at: string
          group_id: string
          id: string
          module_id: string | null
          profile_id: string | null
          sent_at: string
          telegram_chat_id: number
          telegram_message_id: number
          telegram_thread_id: number | null
          telegram_user_id: number
        }
        Insert: {
          created_at?: string
          group_id: string
          id?: string
          module_id?: string | null
          profile_id?: string | null
          sent_at?: string
          telegram_chat_id: number
          telegram_message_id: number
          telegram_thread_id?: number | null
          telegram_user_id: number
        }
        Update: {
          created_at?: string
          group_id?: string
          id?: string
          module_id?: string | null
          profile_id?: string | null
          sent_at?: string
          telegram_chat_id?: number
          telegram_message_id?: number
          telegram_thread_id?: number | null
          telegram_user_id?: number
        }
        Relationships: [
          {
            foreignKeyName: "group_message_events_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_message_events_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_message_events_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "mv_lesson_dropoff"
            referencedColumns: ["module_id"]
          },
          {
            foreignKeyName: "group_message_events_profile_id_fkey"
            columns: ["profile_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      group_module_topics: {
        Row: {
          created_at: string
          created_by: string | null
          group_id: string
          id: string
          module_id: string
          telegram_topic_id: number | null
          telegram_topic_url: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          group_id: string
          id?: string
          module_id: string
          telegram_topic_id?: number | null
          telegram_topic_url: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          group_id?: string
          id?: string
          module_id?: string
          telegram_topic_id?: number | null
          telegram_topic_url?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "group_module_topics_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_module_topics_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "group_module_topics_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "mv_lesson_dropoff"
            referencedColumns: ["module_id"]
          },
        ]
      }
      groups: {
        Row: {
          course_id: string | null
          created_at: string
          homework_topic_id: number | null
          homework_topic_url: string | null
          id: string
          is_default: boolean
          name: string
          teacher_id: string | null
          telegram_group_url: string | null
          updated_at: string
        }
        Insert: {
          course_id?: string | null
          created_at?: string
          homework_topic_id?: number | null
          homework_topic_url?: string | null
          id?: string
          is_default?: boolean
          name: string
          teacher_id?: string | null
          telegram_group_url?: string | null
          updated_at?: string
        }
        Update: {
          course_id?: string | null
          created_at?: string
          homework_topic_id?: number | null
          homework_topic_url?: string | null
          id?: string
          is_default?: boolean
          name?: string
          teacher_id?: string | null
          telegram_group_url?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "groups_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      homework_assignments: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          due_days_after_module_unlock: number
          id: string
          is_active: boolean
          max_score: number
          module_id: string
          parent_id: string | null
          prompt_en: string | null
          prompt_ru: string | null
          prompt_uz: string | null
          sap_number: number | null
          task_number: number
          title: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_days_after_module_unlock?: number
          id?: string
          is_active?: boolean
          max_score?: number
          module_id: string
          parent_id?: string | null
          prompt_en?: string | null
          prompt_ru?: string | null
          prompt_uz?: string | null
          sap_number?: number | null
          task_number?: number
          title: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          due_days_after_module_unlock?: number
          id?: string
          is_active?: boolean
          max_score?: number
          module_id?: string
          parent_id?: string | null
          prompt_en?: string | null
          prompt_ru?: string | null
          prompt_uz?: string | null
          sap_number?: number | null
          task_number?: number
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "homework_assignments_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homework_assignments_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "mv_lesson_dropoff"
            referencedColumns: ["module_id"]
          },
          {
            foreignKeyName: "homework_assignments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "homework_assignments"
            referencedColumns: ["id"]
          },
        ]
      }
      homework_submissions: {
        Row: {
          assignment_id: string
          attempt_number: number
          created_at: string
          id: string
          is_late: boolean
          previous_attempts: Json
          score: number | null
          score_feedback: string | null
          score_is_stale: boolean
          scored_at: string | null
          scored_by: string | null
          source: string
          submitted_at: string
          submitted_image_url: string | null
          submitted_text: string
          telegram_chat_id: number | null
          telegram_file_id: string | null
          telegram_file_kind: string | null
          telegram_message_id: number | null
          telegram_message_url: string | null
          telegram_thread_id: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          assignment_id: string
          attempt_number?: number
          created_at?: string
          id?: string
          is_late?: boolean
          previous_attempts?: Json
          score?: number | null
          score_feedback?: string | null
          score_is_stale?: boolean
          scored_at?: string | null
          scored_by?: string | null
          source?: string
          submitted_at?: string
          submitted_image_url?: string | null
          submitted_text?: string
          telegram_chat_id?: number | null
          telegram_file_id?: string | null
          telegram_file_kind?: string | null
          telegram_message_id?: number | null
          telegram_message_url?: string | null
          telegram_thread_id?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          assignment_id?: string
          attempt_number?: number
          created_at?: string
          id?: string
          is_late?: boolean
          previous_attempts?: Json
          score?: number | null
          score_feedback?: string | null
          score_is_stale?: boolean
          scored_at?: string | null
          scored_by?: string | null
          source?: string
          submitted_at?: string
          submitted_image_url?: string | null
          submitted_text?: string
          telegram_chat_id?: number | null
          telegram_file_id?: string | null
          telegram_file_kind?: string | null
          telegram_message_id?: number | null
          telegram_message_url?: string | null
          telegram_thread_id?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "homework_submissions_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "homework_assignments"
            referencedColumns: ["id"]
          },
        ]
      }
      homework_teacher_dm_queue: {
        Row: {
          assignment_id: string
          assignment_title: string | null
          created_at: string
          error: string | null
          group_id: string
          id: string
          message_url: string
          module_id: string
          module_number: number
          queued_for_quiet_hours: boolean
          scheduled_for: string
          sent_at: string | null
          student_id: string
          student_name: string | null
          submission_id: string
          task_number: number
          teacher_id: string
        }
        Insert: {
          assignment_id: string
          assignment_title?: string | null
          created_at?: string
          error?: string | null
          group_id: string
          id?: string
          message_url: string
          module_id: string
          module_number: number
          queued_for_quiet_hours?: boolean
          scheduled_for?: string
          sent_at?: string | null
          student_id: string
          student_name?: string | null
          submission_id: string
          task_number: number
          teacher_id: string
        }
        Update: {
          assignment_id?: string
          assignment_title?: string | null
          created_at?: string
          error?: string | null
          group_id?: string
          id?: string
          message_url?: string
          module_id?: string
          module_number?: number
          queued_for_quiet_hours?: boolean
          scheduled_for?: string
          sent_at?: string | null
          student_id?: string
          student_name?: string | null
          submission_id?: string
          task_number?: number
          teacher_id?: string
        }
        Relationships: []
      }
      leaderboard_cache: {
        Row: {
          computed_at: string
          current_streak: number
          lessons_30d: number
          minutes_30d: number
          rank: number | null
          score: number
          user_id: string
        }
        Insert: {
          computed_at?: string
          current_streak?: number
          lessons_30d?: number
          minutes_30d?: number
          rank?: number | null
          score?: number
          user_id: string
        }
        Update: {
          computed_at?: string
          current_streak?: number
          lessons_30d?: number
          minutes_30d?: number
          rank?: number | null
          score?: number
          user_id?: string
        }
        Relationships: []
      }
      lesson_bookmarks: {
        Row: {
          created_at: string
          id: string
          label: string | null
          lesson_id: string
          timestamp_seconds: number
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          label?: string | null
          lesson_id: string
          timestamp_seconds?: number
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          label?: string | null
          lesson_id?: string
          timestamp_seconds?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lesson_bookmarks_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_bookmarks_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "mv_lesson_dropoff"
            referencedColumns: ["lesson_id"]
          },
        ]
      }
      lesson_comments: {
        Row: {
          body: string
          created_at: string
          id: string
          lesson_id: string
          parent_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          body: string
          created_at?: string
          id?: string
          lesson_id: string
          parent_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string
          created_at?: string
          id?: string
          lesson_id?: string
          parent_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lesson_comments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_comments_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "mv_lesson_dropoff"
            referencedColumns: ["lesson_id"]
          },
          {
            foreignKeyName: "lesson_comments_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "lesson_comments"
            referencedColumns: ["id"]
          },
        ]
      }
      lesson_notes: {
        Row: {
          body: string | null
          id: string
          lesson_id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          body?: string | null
          id?: string
          lesson_id: string
          updated_at?: string
          user_id: string
        }
        Update: {
          body?: string | null
          id?: string
          lesson_id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lesson_notes_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_notes_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "mv_lesson_dropoff"
            referencedColumns: ["lesson_id"]
          },
        ]
      }
      lesson_progress: {
        Row: {
          completed_at: string | null
          duration_seconds_v2: number | null
          id: string
          last_position_seconds: number | null
          lesson_id: string
          max_position_seconds: number
          seconds_watched: number | null
          updated_at: string
          user_id: string
          watch_seconds_total: number
        }
        Insert: {
          completed_at?: string | null
          duration_seconds_v2?: number | null
          id?: string
          last_position_seconds?: number | null
          lesson_id: string
          max_position_seconds?: number
          seconds_watched?: number | null
          updated_at?: string
          user_id: string
          watch_seconds_total?: number
        }
        Update: {
          completed_at?: string | null
          duration_seconds_v2?: number | null
          id?: string
          last_position_seconds?: number | null
          lesson_id?: string
          max_position_seconds?: number
          seconds_watched?: number | null
          updated_at?: string
          user_id?: string
          watch_seconds_total?: number
        }
        Relationships: [
          {
            foreignKeyName: "lesson_progress_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_progress_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "mv_lesson_dropoff"
            referencedColumns: ["lesson_id"]
          },
        ]
      }
      lesson_ratings: {
        Row: {
          created_at: string
          feedback: string | null
          id: string
          lesson_id: string
          stars: number
          user_id: string
        }
        Insert: {
          created_at?: string
          feedback?: string | null
          id?: string
          lesson_id: string
          stars: number
          user_id: string
        }
        Update: {
          created_at?: string
          feedback?: string | null
          id?: string
          lesson_id?: string
          stars?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "lesson_ratings_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "lessons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lesson_ratings_lesson_id_fkey"
            columns: ["lesson_id"]
            isOneToOne: false
            referencedRelation: "mv_lesson_dropoff"
            referencedColumns: ["lesson_id"]
          },
        ]
      }
      lessons: {
        Row: {
          created_at: string
          description: string | null
          duration_seconds: number | null
          id: string
          module_id: string
          position: number
          provider_video_id: string | null
          published: boolean
          resources: Json | null
          thumbnail_path: string | null
          title: string
          transcript: string | null
          video_provider: string
          video_storage_path: string | null
          video_url: string | null
        }
        Insert: {
          created_at?: string
          description?: string | null
          duration_seconds?: number | null
          id?: string
          module_id: string
          position?: number
          provider_video_id?: string | null
          published?: boolean
          resources?: Json | null
          thumbnail_path?: string | null
          title: string
          transcript?: string | null
          video_provider?: string
          video_storage_path?: string | null
          video_url?: string | null
        }
        Update: {
          created_at?: string
          description?: string | null
          duration_seconds?: number | null
          id?: string
          module_id?: string
          position?: number
          provider_video_id?: string | null
          published?: boolean
          resources?: Json | null
          thumbnail_path?: string | null
          title?: string
          transcript?: string | null
          video_provider?: string
          video_storage_path?: string | null
          video_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lessons_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lessons_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "mv_lesson_dropoff"
            referencedColumns: ["module_id"]
          },
        ]
      }
      login_attempts: {
        Row: {
          created_at: string
          id: string
          key: string
          kind: string
          success: boolean
          user_agent: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          key: string
          kind: string
          success?: boolean
          user_agent?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          key?: string
          kind?: string
          success?: boolean
          user_agent?: string | null
        }
        Relationships: []
      }
      module_celebrations: {
        Row: {
          caption: string | null
          created_at: string
          id: string
          image_url: string | null
          module_id: string
          seen_at: string | null
          user_id: string
        }
        Insert: {
          caption?: string | null
          created_at?: string
          id?: string
          image_url?: string | null
          module_id: string
          seen_at?: string | null
          user_id: string
        }
        Update: {
          caption?: string | null
          created_at?: string
          id?: string
          image_url?: string | null
          module_id?: string
          seen_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      modules: {
        Row: {
          course_id: string
          created_at: string
          id: string
          position: number
          summary: string | null
          title: string
        }
        Insert: {
          course_id: string
          created_at?: string
          id?: string
          position?: number
          summary?: string | null
          title: string
        }
        Update: {
          course_id?: string
          created_at?: string
          id?: string
          position?: number
          summary?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "modules_course_id_fkey"
            columns: ["course_id"]
            isOneToOne: false
            referencedRelation: "courses"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_template_variables: {
        Row: {
          description: string | null
          template_key: string
          variable_name: string
        }
        Insert: {
          description?: string | null
          template_key: string
          variable_name: string
        }
        Update: {
          description?: string | null
          template_key?: string
          variable_name?: string
        }
        Relationships: []
      }
      notification_templates: {
        Row: {
          body: string
          button_label: string | null
          locale: string
          template_key: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          body: string
          button_label?: string | null
          locale: string
          template_key: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          body?: string
          button_label?: string | null
          locale?: string
          template_key?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      notifications_log: {
        Row: {
          id: string
          notification_type: string
          payload: Json
          sent_at: string
          user_id: string
        }
        Insert: {
          id?: string
          notification_type: string
          payload?: Json
          sent_at?: string
          user_id: string
        }
        Update: {
          id?: string
          notification_type?: string
          payload?: Json
          sent_at?: string
          user_id?: string
        }
        Relationships: []
      }
      nudge_log: {
        Row: {
          clicked_at: string | null
          error: string | null
          id: string
          magic_token: string | null
          nudge_type: string
          payload: Json
          profile_id: string
          sent_at: string
          telegram_message_id: string | null
        }
        Insert: {
          clicked_at?: string | null
          error?: string | null
          id?: string
          magic_token?: string | null
          nudge_type: string
          payload?: Json
          profile_id: string
          sent_at?: string
          telegram_message_id?: string | null
        }
        Update: {
          clicked_at?: string | null
          error?: string | null
          id?: string
          magic_token?: string | null
          nudge_type?: string
          payload?: Json
          profile_id?: string
          sent_at?: string
          telegram_message_id?: string | null
        }
        Relationships: []
      }
      nudge_module_celebrations: {
        Row: {
          module_id: string
          profile_id: string
          queued_at: string
          sent_at: string | null
        }
        Insert: {
          module_id: string
          profile_id: string
          queued_at?: string
          sent_at?: string | null
        }
        Update: {
          module_id?: string
          profile_id?: string
          queued_at?: string
          sent_at?: string | null
        }
        Relationships: []
      }
      nudge_preferences: {
        Row: {
          opt_in: boolean
          paused_until: string | null
          profile_id: string
          updated_at: string
        }
        Insert: {
          opt_in?: boolean
          paused_until?: string | null
          profile_id: string
          updated_at?: string
        }
        Update: {
          opt_in?: boolean
          paused_until?: string | null
          profile_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      platform_settings: {
        Row: {
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          updated_by?: string | null
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: []
      }
      profiles: {
        Row: {
          active_teacher_group_id: string | null
          archived_at: string | null
          avatar_url: string | null
          created_at: string
          digest_opt_in: boolean
          email: string
          goals: string | null
          group_id: string | null
          id: string
          last_daily_reminder_at: string | null
          last_inactive_warning_at: string | null
          last_inactive_warning_day: number | null
          last_name: string | null
          last_streak_warning_at: string | null
          name: string | null
          name_confirmed_at: string | null
          name_prompt_last_at: string | null
          notifications_enabled: boolean
          onboarding_completed: boolean | null
          preferred_language: string | null
          preferred_locale: string
          reminder_time: string
          stats_dirty_at: string | null
          status: Database["public"]["Enums"]["user_status"]
          tashkent_offset_minutes: number
          telegram_id: number | null
          telegram_onboarded_at: string | null
          telegram_username: string | null
          timezone: string | null
          updated_at: string
          weekly_goal_lessons: number | null
        }
        Insert: {
          active_teacher_group_id?: string | null
          archived_at?: string | null
          avatar_url?: string | null
          created_at?: string
          digest_opt_in?: boolean
          email: string
          goals?: string | null
          group_id?: string | null
          id: string
          last_daily_reminder_at?: string | null
          last_inactive_warning_at?: string | null
          last_inactive_warning_day?: number | null
          last_name?: string | null
          last_streak_warning_at?: string | null
          name?: string | null
          name_confirmed_at?: string | null
          name_prompt_last_at?: string | null
          notifications_enabled?: boolean
          onboarding_completed?: boolean | null
          preferred_language?: string | null
          preferred_locale?: string
          reminder_time?: string
          stats_dirty_at?: string | null
          status?: Database["public"]["Enums"]["user_status"]
          tashkent_offset_minutes?: number
          telegram_id?: number | null
          telegram_onboarded_at?: string | null
          telegram_username?: string | null
          timezone?: string | null
          updated_at?: string
          weekly_goal_lessons?: number | null
        }
        Update: {
          active_teacher_group_id?: string | null
          archived_at?: string | null
          avatar_url?: string | null
          created_at?: string
          digest_opt_in?: boolean
          email?: string
          goals?: string | null
          group_id?: string | null
          id?: string
          last_daily_reminder_at?: string | null
          last_inactive_warning_at?: string | null
          last_inactive_warning_day?: number | null
          last_name?: string | null
          last_streak_warning_at?: string | null
          name?: string | null
          name_confirmed_at?: string | null
          name_prompt_last_at?: string | null
          notifications_enabled?: boolean
          onboarding_completed?: boolean | null
          preferred_language?: string | null
          preferred_locale?: string
          reminder_time?: string
          stats_dirty_at?: string | null
          status?: Database["public"]["Enums"]["user_status"]
          tashkent_offset_minutes?: number
          telegram_id?: number | null
          telegram_onboarded_at?: string | null
          telegram_username?: string | null
          timezone?: string | null
          updated_at?: string
          weekly_goal_lessons?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_active_teacher_group_id_fkey"
            columns: ["active_teacher_group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
      }
      progress_audit: {
        Row: {
          after: Json | null
          before: Json | null
          changed_at: string
          db_user: string
          id: string
          op: string
          row_id: string | null
          table_name: string
          user_id: string | null
        }
        Insert: {
          after?: Json | null
          before?: Json | null
          changed_at?: string
          db_user?: string
          id?: string
          op: string
          row_id?: string | null
          table_name: string
          user_id?: string | null
        }
        Update: {
          after?: Json | null
          before?: Json | null
          changed_at?: string
          db_user?: string
          id?: string
          op?: string
          row_id?: string | null
          table_name?: string
          user_id?: string | null
        }
        Relationships: []
      }
      quiz_attempts: {
        Row: {
          answers: Json
          completed_at: string
          id: string
          module_id: string
          score: number
          user_id: string
        }
        Insert: {
          answers?: Json
          completed_at?: string
          id?: string
          module_id: string
          score?: number
          user_id: string
        }
        Update: {
          answers?: Json
          completed_at?: string
          id?: string
          module_id?: string
          score?: number
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "quiz_attempts_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_attempts_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "mv_lesson_dropoff"
            referencedColumns: ["module_id"]
          },
        ]
      }
      quiz_questions: {
        Row: {
          correct_index: number
          created_at: string
          explanation: string | null
          id: string
          module_id: string
          options: Json
          position: number
          question: string
        }
        Insert: {
          correct_index?: number
          created_at?: string
          explanation?: string | null
          id?: string
          module_id: string
          options?: Json
          position?: number
          question: string
        }
        Update: {
          correct_index?: number
          created_at?: string
          explanation?: string | null
          id?: string
          module_id?: string
          options?: Json
          position?: number
          question?: string
        }
        Relationships: [
          {
            foreignKeyName: "quiz_questions_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quiz_questions_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "mv_lesson_dropoff"
            referencedColumns: ["module_id"]
          },
        ]
      }
      re_engagement_campaigns: {
        Row: {
          button_text_en: string
          button_text_ru: string
          button_text_uz: string
          cadence_days: number[]
          created_at: string
          created_by: string | null
          enabled: boolean
          id: string
          name: string
          template_en: string
          template_ru: string
          template_uz: string
        }
        Insert: {
          button_text_en?: string
          button_text_ru?: string
          button_text_uz?: string
          cadence_days?: number[]
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          name: string
          template_en?: string
          template_ru?: string
          template_uz?: string
        }
        Update: {
          button_text_en?: string
          button_text_ru?: string
          button_text_uz?: string
          cadence_days?: number[]
          created_at?: string
          created_by?: string | null
          enabled?: boolean
          id?: string
          name?: string
          template_en?: string
          template_ru?: string
          template_uz?: string
        }
        Relationships: []
      }
      re_engagement_deliveries: {
        Row: {
          activated_at: string | null
          attempt_num: number
          campaign_id: string
          clicked_at: string | null
          error: string | null
          id: string
          magic_token: string | null
          profile_id: string
          sent_at: string
          status: string
          telegram_message_id: string | null
        }
        Insert: {
          activated_at?: string | null
          attempt_num?: number
          campaign_id: string
          clicked_at?: string | null
          error?: string | null
          id?: string
          magic_token?: string | null
          profile_id: string
          sent_at?: string
          status?: string
          telegram_message_id?: string | null
        }
        Update: {
          activated_at?: string | null
          attempt_num?: number
          campaign_id?: string
          clicked_at?: string | null
          error?: string | null
          id?: string
          magic_token?: string | null
          profile_id?: string
          sent_at?: string
          status?: string
          telegram_message_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "re_engagement_deliveries_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "re_engagement_campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      streaks: {
        Row: {
          current_streak: number
          freezes_remaining: number
          last_active_date: string | null
          longest_streak: number
          user_id: string
        }
        Insert: {
          current_streak?: number
          freezes_remaining?: number
          last_active_date?: string | null
          longest_streak?: number
          user_id: string
        }
        Update: {
          current_streak?: number
          freezes_remaining?: number
          last_active_date?: string | null
          longest_streak?: number
          user_id?: string
        }
        Relationships: []
      }
      telegram_login_tokens: {
        Row: {
          authenticated_at: string | null
          created_at: string
          expires_at: string
          status: string
          token: string
          user_id: string | null
        }
        Insert: {
          authenticated_at?: string | null
          created_at?: string
          expires_at?: string
          status?: string
          token: string
          user_id?: string | null
        }
        Update: {
          authenticated_at?: string | null
          created_at?: string
          expires_at?: string
          status?: string
          token?: string
          user_id?: string | null
        }
        Relationships: []
      }
      telegram_magic_links: {
        Row: {
          created_at: string
          expires_at: string
          purpose: string
          target_path: string | null
          token: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          expires_at?: string
          purpose?: string
          target_path?: string | null
          token: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          expires_at?: string
          purpose?: string
          target_path?: string | null
          token?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      user_badges: {
        Row: {
          badge_id: string
          earned_at: string
          id: string
          user_id: string
        }
        Insert: {
          badge_id: string
          earned_at?: string
          id?: string
          user_id: string
        }
        Update: {
          badge_id?: string
          earned_at?: string
          id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_badges_badge_id_fkey"
            columns: ["badge_id"]
            isOneToOne: false
            referencedRelation: "badges"
            referencedColumns: ["id"]
          },
        ]
      }
      user_daily_goal: {
        Row: {
          target: number
          updated_at: string
          user_id: string
        }
        Insert: {
          target?: number
          updated_at?: string
          user_id: string
        }
        Update: {
          target?: number
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      webhook_inbox: {
        Row: {
          chat_id: number | null
          chat_title: string | null
          chat_type: string | null
          from_user_id: number | null
          from_username: string | null
          id: number
          message_id: number | null
          message_thread_id: number | null
          raw_update: Json
          received_at: string
          resolution: Json | null
          text_preview: string | null
          update_type: string | null
        }
        Insert: {
          chat_id?: number | null
          chat_title?: string | null
          chat_type?: string | null
          from_user_id?: number | null
          from_username?: string | null
          id?: number
          message_id?: number | null
          message_thread_id?: number | null
          raw_update: Json
          received_at?: string
          resolution?: Json | null
          text_preview?: string | null
          update_type?: string | null
        }
        Update: {
          chat_id?: number | null
          chat_title?: string | null
          chat_type?: string | null
          from_user_id?: number | null
          from_username?: string | null
          id?: number
          message_id?: number | null
          message_thread_id?: number | null
          raw_update?: Json
          received_at?: string
          resolution?: Json | null
          text_preview?: string | null
          update_type?: string | null
        }
        Relationships: []
      }
      weekly_group_star: {
        Row: {
          created_at: string
          dm_sent_at: string | null
          group_id: string
          score: number
          user_id: string
          week_start: string
        }
        Insert: {
          created_at?: string
          dm_sent_at?: string | null
          group_id: string
          score?: number
          user_id: string
          week_start: string
        }
        Update: {
          created_at?: string
          dm_sent_at?: string | null
          group_id?: string
          score?: number
          user_id?: string
          week_start?: string
        }
        Relationships: []
      }
    }
    Views: {
      mv_cohort_retention: {
        Row: {
          active_users: number | null
          cohort_size: number | null
          cohort_week: string | null
          retention_pct: number | null
          week_offset: number | null
        }
        Relationships: []
      }
      mv_funnel_stages: {
        Row: {
          stage_key: string | null
          stage_order: number | null
          users: number | null
        }
        Relationships: []
      }
      mv_lesson_dropoff: {
        Row: {
          completes: number | null
          completion_rate: number | null
          histogram: Json | null
          lesson_id: string | null
          lesson_pos: number | null
          lesson_title: string | null
          module_id: string | null
          module_pos: number | null
          module_title: string | null
          starts: number | null
        }
        Relationships: []
      }
      mv_study_heatmap_30d: {
        Row: {
          dow: number | null
          hour: number | null
          minutes: number | null
        }
        Relationships: []
      }
      vw_module_homework_score: {
        Row: {
          avg_score_normalized: number | null
          module_id: string | null
          module_max: number | null
          module_total: number | null
          profile_id: string | null
          scored_tasks: number | null
          total_active_tasks_in_module: number | null
          total_submitted_tasks: number | null
        }
        Relationships: [
          {
            foreignKeyName: "homework_assignments_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homework_assignments_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "mv_lesson_dropoff"
            referencedColumns: ["module_id"]
          },
        ]
      }
      vw_module_homework_score_effective: {
        Row: {
          avg10_normalized: number | null
          earned: number | null
          max_scored: number | null
          module_id: string | null
          profile_id: string | null
          scored_tasks: number | null
          submitted_tasks: number | null
        }
        Relationships: [
          {
            foreignKeyName: "homework_assignments_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "modules"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "homework_assignments_module_id_fkey"
            columns: ["module_id"]
            isOneToOne: false
            referencedRelation: "mv_lesson_dropoff"
            referencedColumns: ["module_id"]
          },
        ]
      }
    }
    Functions: {
      admin_assign_group: {
        Args: { _group_id: string; _user_ids: string[] }
        Returns: number
      }
      admin_change_role: {
        Args: { _new_role: string; _target: string }
        Returns: undefined
      }
      admin_course_progress: {
        Args: { _course_id: string }
        Returns: {
          completed_count: number
          last_activity: string
          pct: number
          total_count: number
          user_id: string
        }[]
      }
      admin_export_group_csv: {
        Args: { _group_id: string; _include_archived?: boolean }
        Returns: {
          created_at: string
          email: string
          first_login_at: string
          group_name: string
          has_logged_in: boolean
          homework_avg: number
          id: string
          last_login_at: string
          last_name: string
          lessons_completed: number
          name: string
          role: string
          status: Database["public"]["Enums"]["user_status"]
          telegram_user_id: number
          telegram_username: string
        }[]
      }
      admin_group_engagement_stats:
        | {
            Args: { p_caller_profile_id?: string }
            Returns: {
              active_3d_count: number
              group_id: string
              logged_in_count: number
              total_active: number
            }[]
          }
        | {
            Args: { p_caller_profile_id?: string; p_window_days?: number }
            Returns: {
              active_count: number
              group_id: string
              logged_in_count: number
              total_active: number
            }[]
          }
      admin_group_module_submissions: {
        Args: { p_caller_profile_id?: string }
        Returns: {
          group_id: string
          module_id: string
          module_position: number
          module_title: string
          submitted_count: number
          total_students: number
        }[]
      }
      admin_list_users: {
        Args: never
        Returns: {
          archived_at: string
          avatar_url: string
          created_at: string
          email: string
          id: string
          is_admin: boolean
          last_sign_in_at: string
          name: string
          status: Database["public"]["Enums"]["user_status"]
          telegram_id: number
          telegram_username: string
        }[]
      }
      admin_list_users_internal: {
        Args: never
        Returns: {
          avatar_url: string
          created_at: string
          email: string
          id: string
          is_admin: boolean
          last_sign_in_at: string
          name: string
          status: Database["public"]["Enums"]["user_status"]
          telegram_id: number
          telegram_username: string
        }[]
      }
      admin_ungrouped_students: {
        Args: never
        Returns: {
          created_at: string
          email: string
          id: string
          last_name: string
          last_sign_in_at: string
          name: string
          telegram_id: number
          telegram_username: string
        }[]
      }
      analytics_cohorts: {
        Args: never
        Returns: {
          active_users: number
          cohort_size: number
          cohort_week: string
          retention_pct: number
          week_offset: number
        }[]
      }
      analytics_funnel: {
        Args: never
        Returns: {
          stage_key: string
          stage_order: number
          users: number
        }[]
      }
      analytics_heatmap: {
        Args: never
        Returns: {
          dow: number
          hour: number
          minutes: number
        }[]
      }
      analytics_lesson_dropoff: {
        Args: never
        Returns: {
          completes: number
          completion_rate: number
          histogram: Json
          lesson_id: string
          lesson_pos: number
          lesson_title: string
          module_id: string
          module_pos: number
          module_title: string
          starts: number
        }[]
      }
      analytics_teacher_quality: {
        Args: { _min_students?: number }
        Returns: {
          active_7d_pct: number
          avg_completion_pct: number
          avg_homework_score: number
          finished_course: number
          quality_score: number
          students_count: number
          teacher_email: string
          teacher_id: string
          teacher_name: string
        }[]
      }
      award_badge: { Args: { _code: string; uid: string }; Returns: undefined }
      can_see_group: {
        Args: { _group_id: string; _uid: string }
        Returns: boolean
      }
      current_group_star: {
        Args: { uid: string }
        Returns: {
          first_name: string
          is_me: boolean
          last_initial: string
        }[]
      }
      daily_goal_progress: {
        Args: { uid: string }
        Returns: {
          done: number
          target: number
        }[]
      }
      get_public_setting: { Args: { _key: string }; Returns: Json }
      get_quiz_questions_for_module: {
        Args: { _module_id: string }
        Returns: {
          id: string
          module_id: string
          options: Json
          position: number
          question: string
        }[]
      }
      get_setting: { Args: { _key: string }; Returns: Json }
      get_settings: {
        Args: { _keys: string[] }
        Returns: {
          key: string
          value: Json
        }[]
      }
      get_visible_student_ids: {
        Args: { _scope_user_id?: string }
        Returns: {
          id: string
        }[]
      }
      grade_quiz_attempt: {
        Args: { _answers: Json; _module_id: string }
        Returns: Json
      }
      group_health_score: { Args: { _group_id: string }; Returns: number }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      homework_pending_count_for_user: {
        Args: { _uid: string }
        Returns: number
      }
      internal_fn_secret: { Args: never; Returns: string }
      leaderboard_group_window: {
        Args: { _around?: number; uid: string }
        Returns: {
          first_name: string
          group_rank: number
          group_total: number
          is_me: boolean
          last_initial: string
          score: number
          user_id: string
        }[]
      }
      leaderboard_my_rank: {
        Args: { uid: string }
        Returns: {
          rank: number
          score: number
          total: number
        }[]
      }
      leaderboard_top: {
        Args: { _limit?: number }
        Returns: {
          current_streak: number
          first_name: string
          last_initial: string
          lessons_30d: number
          rank: number
          score: number
          user_id: string
        }[]
      }
      match_ai_knowledge: {
        Args: { _course_id: string; _limit?: number; _query_embedding: string }
        Returns: {
          chunk_id: string
          chunk_index: number
          content: string
          document_id: string
          file_name: string
          scope: Database["public"]["Enums"]["knowledge_scope"]
          similarity: number
        }[]
      }
      nudge_candidates_inactive: {
        Args: { _days: number }
        Returns: {
          id: string
          name: string
          preferred_language: string
          preferred_locale: string
          tashkent_offset_minutes: number
          teacher_name: string
          telegram_id: number
        }[]
      }
      nudge_candidates_stuck: {
        Args: never
        Returns: {
          id: string
          lesson_id: string
          lesson_title: string
          name: string
          preferred_language: string
          preferred_locale: string
          tashkent_offset_minutes: number
          telegram_id: number
        }[]
      }
      nudge_cron_set_enabled: {
        Args: { _enabled: boolean }
        Returns: undefined
      }
      nudge_cron_status: {
        Args: never
        Returns: {
          active: boolean
          jobname: string
          schedule: string
        }[]
      }
      online_now_count: { Args: never; Returns: number }
      pick_weekly_group_stars: { Args: never; Returns: undefined }
      re_engagement_eligible_count: {
        Args: never
        Returns: {
          never_logged_in: number
          with_tg: number
          without_tg: number
        }[]
      }
      re_engagement_eligible_profiles: {
        Args: never
        Returns: {
          email: string
          id: string
          last_name: string
          name: string
          preferred_locale: string
          telegram_id: number
          telegram_username: string
        }[]
      }
      recalc_leaderboard: { Args: never; Returns: undefined }
      refresh_all_analytics: { Args: never; Returns: undefined }
      staff_group_members: {
        Args: { _group_id: string }
        Returns: {
          avg_score: number
          completed_lessons: number
          email: string
          id: string
          last_activity_at: string
          last_name: string
          last_sign_in_at: string
          name: string
          telegram_id: number
          telegram_username: string
        }[]
      }
      staff_group_module_completion: {
        Args: { _group_id: string }
        Returns: {
          completion_pct: number
          module_id: string
          module_position: number
          title: string
        }[]
      }
      staff_group_overview: {
        Args: { _group_id: string }
        Returns: {
          active_7d: number
          avg_completion_pct: number
          avg_score_pct: number
          course_id: string
          course_name: string
          created_at: string
          group_id: string
          group_name: string
          health: number
          teacher_id: string
          teacher_name: string
          total_students: number
        }[]
      }
      staff_group_recent_activity: {
        Args: { _group_id: string; _lim?: number }
        Returns: {
          kind: string
          lesson_id: string
          lesson_title: string
          name: string
          occurred_at: string
          user_id: string
        }[]
      }
      staff_list_students: {
        Args: never
        Returns: {
          avatar_url: string
          created_at: string
          email: string
          group_id: string
          id: string
          is_admin: boolean
          last_name: string
          last_sign_in_at: string
          name: string
          status: Database["public"]["Enums"]["user_status"]
          telegram_id: number
          telegram_username: string
        }[]
      }
      staff_recent_auth_events: {
        Args: { _since: string }
        Returns: {
          created_at: string
          user_id: string
        }[]
      }
      staff_recent_lesson_progress: {
        Args: { _since: string }
        Returns: {
          completed_at: string
          lesson_id: string
          updated_at: string
          user_id: string
        }[]
      }
      staff_top_students: {
        Args: { _lim?: number }
        Returns: {
          avg_score: number
          completed_lessons: number
          id: string
          last_activity_at: string
          name: string
          telegram_username: string
        }[]
      }
      start_homework_resubmission: {
        Args: { p_submission_id: string }
        Returns: {
          assignment_id: string
          attempt_number: number
          created_at: string
          id: string
          is_late: boolean
          previous_attempts: Json
          score: number | null
          score_feedback: string | null
          score_is_stale: boolean
          scored_at: string | null
          scored_by: string | null
          source: string
          submitted_at: string
          submitted_image_url: string | null
          submitted_text: string
          telegram_chat_id: number | null
          telegram_file_id: string | null
          telegram_file_kind: string | null
          telegram_message_id: number | null
          telegram_message_url: string | null
          telegram_thread_id: number | null
          updated_at: string
          user_id: string
        }
        SetofOptions: {
          from: "*"
          to: "homework_submissions"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      teacher_group_statistics:
        | { Args: { p_group_id: string }; Returns: Json }
        | {
            Args: { p_caller_profile_id?: string; p_group_id: string }
            Returns: Json
          }
      track_video_progress: {
        Args: {
          p_current_time: number
          p_delta_seconds: number
          p_duration: number
          p_lesson_id: string
        }
        Returns: Json
      }
      user_homework_avg10_effective: {
        Args: { p_user_id: string; p_within_days?: number }
        Returns: number
      }
      weekly_digest_set_enabled: {
        Args: { _enabled: boolean }
        Returns: boolean
      }
      weekly_digest_status: { Args: never; Returns: boolean }
      zero_broken_streaks: { Args: never; Returns: undefined }
    }
    Enums: {
      app_role: "admin" | "student" | "teacher" | "superadmin"
      chat_role: "user" | "assistant"
      knowledge_scope: "platform" | "course"
      knowledge_status: "pending" | "processing" | "ready" | "failed"
      user_status: "active" | "inactive" | "archived"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "student", "teacher", "superadmin"],
      chat_role: ["user", "assistant"],
      knowledge_scope: ["platform", "course"],
      knowledge_status: ["pending", "processing", "ready", "failed"],
      user_status: ["active", "inactive", "archived"],
    },
  },
} as const
