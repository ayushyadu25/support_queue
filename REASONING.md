PriorityDesk – Solution Reasoning
1. This project solves the problem of managing a busy IT helpdesk queue.
2. Employees can sign up and create accounts using their email address and password.
3. Each Employee can create support problems assigned to their own account.
4. Employees can view only their own assigned problems for privacy and security.
5. Employees can update, reorder, complete, and search their own tickets.
6. HR users can also sign up and create HR accounts.
7. HR users can view all Employees and all support problems in the system.
8. HR can manage tickets from every Employee, including updating their status.
9. The system uses role-based authentication to separate HR and Employee access.
10. Employee roles have restricted access, while HR has full queue visibility.
11. An optional HR validation key can be added to allow only approved people to create HR accounts.
12. Tickets are stored securely in MongoDB Atlas.
13. Every ticket has a customer name, description, status, response deadline, and priority.
14. Problems can start as Normal or Urgent based on their importance.
15. Overdue problems automatically move ahead in the queue.
16. The escalation system raises breached tickets one level: Normal, High, then Urgent.
17. Tickets can be sorted manually, by time left, by priority, or with AI triage.
18. Completed problems are moved into a separate Completed folder.
19. Real-time updates notify the assigned Employee and HR whenever a ticket changes.