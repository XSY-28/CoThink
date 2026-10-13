# Local reminder crash window

A local reminder program writes a due task, sends an operating-system notification, then marks the notification as delivered in a local database. The process may exit between notification and the database update. It may later restart and scan due tasks again.

Assess how to avoid losing reminders while limiting duplicate notifications. State which failure windows cannot be eliminated without an acknowledgement from the notification service. Separate a durable delivery attempt from confirmed human receipt.
