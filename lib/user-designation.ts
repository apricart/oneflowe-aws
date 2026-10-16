/**
 * A user's job title, optional and descriptive only — nothing authorizes on it.
 * Set when an administrator creates or edits a user, and by the department
 * sign-up for its approvers (which holds them to its own, shorter limit).
 * The bound is the `users.designation` column, varchar(80).
 */
export const USER_DESIGNATION_MAX_LENGTH = 80
