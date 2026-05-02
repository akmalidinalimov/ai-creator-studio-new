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
      groups: {
        Row: {
          course_id: string | null
          created_at: string
          id: string
          is_default: boolean
          name: string
          teacher_id: string | null
          updated_at: string
        }
        Insert: {
          course_id?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          name: string
          teacher_id?: string | null
          updated_at?: string
        }
        Update: {
          course_id?: string | null
          created_at?: string
          id?: string
          is_default?: boolean
          name?: string
          teacher_id?: string | null
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
          notifications_enabled: boolean
          onboarding_completed: boolean | null
          preferred_language: string | null
          preferred_locale: string
          reminder_time: string
          status: Database["public"]["Enums"]["user_status"]
          telegram_id: number | null
          telegram_onboarded_at: string | null
          telegram_username: string | null
          timezone: string | null
          updated_at: string
          weekly_goal_lessons: number | null
        }
        Insert: {
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
          notifications_enabled?: boolean
          onboarding_completed?: boolean | null
          preferred_language?: string | null
          preferred_locale?: string
          reminder_time?: string
          status?: Database["public"]["Enums"]["user_status"]
          telegram_id?: number | null
          telegram_onboarded_at?: string | null
          telegram_username?: string | null
          timezone?: string | null
          updated_at?: string
          weekly_goal_lessons?: number | null
        }
        Update: {
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
          notifications_enabled?: boolean
          onboarding_completed?: boolean | null
          preferred_language?: string | null
          preferred_locale?: string
          reminder_time?: string
          status?: Database["public"]["Enums"]["user_status"]
          telegram_id?: number | null
          telegram_onboarded_at?: string | null
          telegram_username?: string | null
          timezone?: string | null
          updated_at?: string
          weekly_goal_lessons?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_group_id_fkey"
            columns: ["group_id"]
            isOneToOne: false
            referencedRelation: "groups"
            referencedColumns: ["id"]
          },
        ]
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
          last_active_date: string | null
          longest_streak: number
          user_id: string
        }
        Insert: {
          current_streak?: number
          last_active_date?: string | null
          longest_streak?: number
          user_id: string
        }
        Update: {
          current_streak?: number
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
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_assign_group: {
        Args: { _group_id: string; _user_ids: string[] }
        Returns: number
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
      admin_list_users: {
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
      award_badge: { Args: { _code: string; uid: string }; Returns: undefined }
      can_see_group: {
        Args: { _group_id: string; _uid: string }
        Returns: boolean
      }
      daily_goal_progress: {
        Args: { uid: string }
        Returns: {
          done: number
          target: number
        }[]
      }
      get_public_setting: { Args: { _key: string }; Returns: Json }
      get_visible_student_ids: {
        Args: { _scope_user_id?: string }
        Returns: {
          id: string
        }[]
      }
      group_health_score: { Args: { _group_id: string }; Returns: number }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
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
          avg_score: number
          completion_pct: number
          health: number
          total: number
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
      track_video_progress: {
        Args: {
          p_current_time: number
          p_delta_seconds: number
          p_duration: number
          p_lesson_id: string
        }
        Returns: Json
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
      user_status: "active" | "inactive"
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
      user_status: ["active", "inactive"],
    },
  },
} as const
